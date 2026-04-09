import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import express from "express";
import { WebSocketServer } from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const HOST = process.env.MONITOR_HOST ?? "0.0.0.0";
const PORT = Number(process.env.MONITOR_PORT ?? "9090");
const INGEST_PATH = process.env.MONITOR_INGEST_PATH ?? "/ingest";

let shuttingDown = false;

let encoderSocket = null;
let encoderMeta = null;
let latestJpeg = null;
let latestFrameTs = null;
let streamActive = true;
const processStartedAt = Date.now();
const gpsState = {
  ok: false,
  lat: null,
  lon: null,
  alt: null,
  speedKmh: null,
  course: null,
  satellites: null,
  fix: null,
  hdop: null,
  accuracyM: null,
  time: null,
  date: null,
  updatedAt: null,
};

let servoReqId = 0;
const pendingServoAcks = new Map();
const videoSubscribers = new Set();
const CAMERA_STALE_MS = Number(process.env.MONITOR_CAMERA_STALE_MS ?? "2500");
const GPS_STALE_MS = Number(process.env.MONITOR_GPS_STALE_MS ?? "4500");
const CONTROL_LOCK_MS = Number(process.env.MONITOR_CONTROL_LOCK_MS ?? "5000");
const stats = {
  framesReceived: 0,
  gpsUpdates: 0,
  servoRequests: 0,
  servoAcksOk: 0,
  servoAcksErr: 0,
  encoderConnects: 0,
  encoderDisconnects: 0,
};
const controlLock = {
  holder: null,
  expiresAt: 0,
};

function getLockState(now = Date.now()) {
  const active = controlLock.expiresAt > now;
  return {
    active,
    holder: active ? controlLock.holder : null,
    remainingMs: active ? Math.max(0, controlLock.expiresAt - now) : 0,
  };
}

function gpsJson() {
  let accuracyM = null;
  if (Number.isFinite(gpsState.eph)) accuracyM = Number(gpsState.eph);
  else if (Number.isFinite(gpsState.hdop)) accuracyM = Math.min(200, Math.max(4, Number(gpsState.hdop) * 5));
  const now = Date.now();
  const frameAgeMs = latestFrameTs ? Math.max(0, now - latestFrameTs) : null;
  const gpsAgeMs = gpsState.updatedAt ? Math.max(0, now - gpsState.updatedAt) : null;
  const lock = getLockState(now);
  return {
    ...gpsState,
    accuracyM,
    encoderConnected: !!encoderSocket,
    encoderMeta,
    frameUpdatedAt: latestFrameTs,
    frameAgeMs,
    gpsAgeMs,
    cameraFresh: frameAgeMs != null && frameAgeMs <= CAMERA_STALE_MS,
    gpsFresh: gpsAgeMs != null && gpsAgeMs <= GPS_STALE_MS,
    streamActive,
    controlLock: lock,
  };
}

function adminStatsJson() {
  const base = gpsJson();
  const upMs = Date.now() - processStartedAt;
  const fpsApprox = base.frameAgeMs != null && base.frameAgeMs <= 2000 ? Math.max(0, Math.round(1000 / Math.max(base.frameAgeMs, 1))) : 0;
  return {
    uptimeMs: upMs,
    streamActive,
    videoSubscribers: videoSubscribers.size,
    ...stats,
    fpsApprox,
    ...base,
  };
}

function broadcastGps(wssGps) {
  const payload = JSON.stringify(gpsJson());
  for (const client of wssGps.clients) {
    if (client.readyState === 1) {
      try {
        client.send(payload);
      } catch {
        // ignore
      }
    }
  }
}

function broadcastFrame(jpeg) {
  const part = Buffer.concat([
    Buffer.from("--frame\r\nContent-Type: image/jpeg\r\n\r\n"),
    jpeg,
    Buffer.from("\r\n"),
  ]);
  for (const res of videoSubscribers) {
    try {
      if (!res.writableEnded) res.write(part);
    } catch {
      videoSubscribers.delete(res);
    }
  }
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/admin", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

app.get("/video_feed", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "multipart/x-mixed-replace; boundary=frame",
    "Cache-Control": "no-cache, no-store, must-revalidate",
    Pragma: "no-cache",
    Connection: "keep-alive",
  });
  videoSubscribers.add(res);
  if (streamActive && latestJpeg) {
    try {
      broadcastFrame(latestJpeg);
    } catch {
      // ignore
    }
  }
  req.on("close", () => {
    videoSubscribers.delete(res);
    try {
      res.end();
    } catch {
      // ignore
    }
  });
});

app.get("/api/gps", (_req, res) => {
  res.json(gpsJson());
});

app.get("/api/admin/stats", (_req, res) => {
  res.json(adminStatsJson());
});

app.post("/api/admin/stream", (req, res) => {
  const action = String(req.body?.action ?? "").toLowerCase();
  if (action === "start") streamActive = true;
  else if (action === "end" || action === "stop") streamActive = false;
  else return res.status(400).json({ ok: false, error: "action must be start or end" });
  return res.json({ ok: true, streamActive });
});

app.post("/api/servo", async (req, res) => {
  stats.servoRequests += 1;
  const clientId = String(req.body?.clientId ?? "").trim();
  if (!clientId) return res.status(400).json({ ok: false, error: "clientId required" });
  const lock = getLockState();
  if (lock.active && lock.holder !== clientId) {
    return res.status(423).json({
      ok: false,
      error: "Controls are locked by another user",
      lock,
    });
  }
  const panRaw = Number(req.body?.pan ?? 50);
  const tiltRaw = Number(req.body?.tilt ?? 50);
  if (!Number.isFinite(panRaw) || !Number.isFinite(tiltRaw)) {
    return res.status(400).json({ ok: false, error: "pan and tilt must be numbers" });
  }
  const pan = Math.round(Math.max(0, Math.min(100, panRaw)));
  const tilt = Math.round(Math.max(0, Math.min(100, tiltRaw)));
  const ws = encoderSocket;
  if (!ws || ws.readyState !== 1) {
    return res.status(503).json({ ok: false, error: "Encoder not connected" });
  }

  const reqId = ++servoReqId;
  const payload = JSON.stringify({ type: "servo", reqId, pan, tilt });
  const ack = await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      pendingServoAcks.delete(reqId);
      resolve({ ok: false, error: "Encoder timeout" });
    }, 900);
    pendingServoAcks.set(reqId, (msg) => {
      clearTimeout(timeout);
      pendingServoAcks.delete(reqId);
      resolve(msg);
    });
    try {
      ws.send(payload);
    } catch {
      clearTimeout(timeout);
      pendingServoAcks.delete(reqId);
      resolve({ ok: false, error: "Encoder send failed" });
    }
  });

  if (ack.ok) {
    controlLock.holder = clientId;
    controlLock.expiresAt = Date.now() + CONTROL_LOCK_MS;
    broadcastGps(gpsWss);
    stats.servoAcksOk += 1;
    return res.json({ ok: true, pan, tilt });
  }
  stats.servoAcksErr += 1;
  return res.status(503).json({ ok: false, error: ack.error ?? "Servo failed" });
});

const httpServer = createServer(app);
const ingestWss = new WebSocketServer({
  noServer: true,
  perMessageDeflate: false,
});
const gpsWss = new WebSocketServer({
  noServer: true,
  perMessageDeflate: false,
});

httpServer.on("upgrade", (req, socket, head) => {
  const url = req.url || "";
  if (url === INGEST_PATH) {
    ingestWss.handleUpgrade(req, socket, head, (ws) => {
      ingestWss.emit("connection", ws, req);
    });
    return;
  }
  if (url === "/ws/gps") {
    gpsWss.handleUpgrade(req, socket, head, (ws) => {
      gpsWss.emit("connection", ws, req);
    });
    return;
  }
  socket.destroy();
});

ingestWss.on("connection", (ws) => {
  stats.encoderConnects += 1;
  if (encoderSocket && encoderSocket !== ws) {
    try {
      encoderSocket.close();
    } catch {
      // ignore
    }
  }
  encoderSocket = ws;
  encoderMeta = null;
  console.log("Encoder connected");
  broadcastGps(gpsWss);

  ws.on("message", (raw) => {
    let msg = null;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "hello") {
      encoderMeta = {
        encoderId: msg.encoderId ?? null,
        connectedAt: Date.now(),
        ...(msg.meta ?? {}),
      };
      broadcastGps(gpsWss);
      return;
    }
    if (msg.type === "gps" && msg.data && typeof msg.data === "object") {
      stats.gpsUpdates += 1;
      Object.assign(gpsState, msg.data);
      if (!gpsState.updatedAt) gpsState.updatedAt = Date.now();
      broadcastGps(gpsWss);
      return;
    }
    if (msg.type === "frame" && typeof msg.jpegBase64 === "string") {
      try {
        stats.framesReceived += 1;
        latestJpeg = Buffer.from(msg.jpegBase64, "base64");
        latestFrameTs = Number(msg.ts ?? Date.now());
        if (streamActive) broadcastFrame(latestJpeg);
      } catch {
        // ignore malformed frame
      }
      return;
    }
    if (msg.type === "servoAck") {
      const resolver = pendingServoAcks.get(Number(msg.reqId));
      if (resolver) resolver(msg);
    }
  });

  ws.on("close", () => {
    if (encoderSocket === ws) {
      stats.encoderDisconnects += 1;
      encoderSocket = null;
      encoderMeta = null;
      console.log("Encoder disconnected");
      broadcastGps(gpsWss);
    }
  });
  ws.on("error", (err) => {
    console.error("Encoder socket error:", err?.message ?? err);
  });
});

gpsWss.on("connection", (ws) => {
  try {
    ws.send(JSON.stringify(gpsJson()));
  } catch {
    // ignore
  }
});

function shutdown() {
  shuttingDown = true;
  for (const res of videoSubscribers) {
    try {
      res.end();
    } catch {
      // ignore
    }
    try {
      res.socket?.destroy();
    } catch {
      // ignore
    }
  }
  videoSubscribers.clear();

  for (const [id, resolve] of pendingServoAcks.entries()) {
    resolve({ ok: false, error: "Server shutting down", reqId: id });
  }
  pendingServoAcks.clear();

  try {
    ingestWss.close();
  } catch {
    // ignore
  }
  try {
    gpsWss.close();
  } catch {
    // ignore
  }

  if (encoderSocket) {
    try {
      encoderSocket.terminate();
    } catch {
      // ignore
    }
    encoderSocket = null;
  }
}

httpServer.listen(PORT, HOST, () => {
  console.log(`Reciever listening on http://127.0.0.1:${PORT}/`);
  console.log(`Waiting for encoder on ws://<this-host>:${PORT}${INGEST_PATH}`);
});

let signalCount = 0;
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    signalCount += 1;
    if (signalCount > 1) process.exit(1);
    if (shuttingDown) return;
    shutdown();
    if (typeof httpServer.closeAllConnections === "function") httpServer.closeAllConnections();
    httpServer.close(() => {
      console.log("Shutdown complete");
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 1500);
  });
}

setInterval(() => {
  if (latestFrameTs && Date.now() - latestFrameTs > 6000) {
    latestJpeg = null;
  }
}, 2000);

// Keep UI freshness indicators updated even when upstream is quiet.
setInterval(() => {
  if (!shuttingDown) broadcastGps(gpsWss);
}, 1000);
