import { createServer } from "node:http";
import { mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import express from "express";
import { WebSocketServer } from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const HOST = process.env.MONITOR_HOST ?? "0.0.0.0";
const PORT = Number(process.env.MONITOR_PORT ?? "9090");
const INGEST_PATH = process.env.MONITOR_INGEST_PATH ?? "/ingest";
const RECORDINGS_DIR = path.join(__dirname, "recordings");
const RECORDING_FPS = Math.max(1, Number(process.env.MONITOR_RECORDING_FPS ?? "15"));
const FFMPEG_BIN = process.env.MONITOR_FFMPEG_PATH ?? "ffmpeg";

let shuttingDown = false;

let encoderSocket = null;
let encoderMeta = null;
let latestJpeg = null;
let latestFrameTs = null;
let latestAudioTs = null;
let audioConfig = { sampleRate: 48000, channels: 1 };
let streamActive = true;
let recordingProc = null;
let recordingName = null;
let recordingStartedAt = null;
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
const MAX_SUBSCRIBER_BUFFER_BYTES = Number(process.env.MONITOR_SUBSCRIBER_MAX_BUFFER_BYTES ?? "524288");
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

mkdirSync(RECORDINGS_DIR, { recursive: true });

function recordingPathForNow() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
  return `stream-${stamp}.mp4`;
}

function normalizeVideoName(rawName) {
  const base = path.basename(String(rawName ?? "").trim());
  if (!base) return null;
  const cleaned = base.replace(/[^\w.\- ]+/g, "").trim();
  if (!cleaned) return null;
  const withExt = cleaned.toLowerCase().endsWith(".mp4") ? cleaned : `${cleaned}.mp4`;
  return withExt;
}

function listRecordings({ includeActive = false } = {}) {
  const names = readdirSync(RECORDINGS_DIR, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.toLowerCase().endsWith(".mp4"))
    .filter((d) => includeActive || !(recordingProc && recordingName && d.name === recordingName))
    .map((d) => d.name);
  const items = [];
  for (const name of names) {
    const fullPath = path.join(RECORDINGS_DIR, name);
    try {
      const s = statSync(fullPath);
      items.push({
        name,
        sizeBytes: s.size,
        createdAt: s.birthtimeMs || s.mtimeMs,
        updatedAt: s.mtimeMs,
        url: `/recordings/${encodeURIComponent(name)}`,
      });
    } catch {
      // ignore disappearing files
    }
  }
  items.sort((a, b) => b.createdAt - a.createdAt);
  return items;
}

function startRecording() {
  if (!streamActive || recordingProc) return;
  const outName = recordingPathForNow();
  const outPath = path.join(RECORDINGS_DIR, outName);
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "mjpeg",
    "-framerate",
    String(RECORDING_FPS),
    "-i",
    "pipe:0",
    "-an",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    outPath,
  ];
  const proc = spawn(FFMPEG_BIN, args, { stdio: ["pipe", "ignore", "pipe"] });
  recordingProc = proc;
  recordingName = outName;
  recordingStartedAt = Date.now();
  proc.stderr.on("data", (b) => {
    const t = b.toString().trim();
    if (t) console.error("[recording ffmpeg]", t);
  });
  proc.on("close", () => {
    recordingProc = null;
    recordingName = null;
    recordingStartedAt = null;
  });
  proc.on("error", (err) => {
    console.error("Recording process error:", err?.message ?? err);
  });
  console.log(`Recording started: ${outName}`);
}

function stopRecording() {
  const proc = recordingProc;
  if (!proc) return;
  try {
    proc.stdin.end();
  } catch {
    // ignore
  }
  setTimeout(() => {
    if (!proc.killed) {
      try {
        proc.kill("SIGTERM");
      } catch {
        // ignore
      }
    }
  }, 1500);
}

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
    recordingActive: !!recordingProc,
    recordingName,
    recordingStartedAt,
    recordingsCount: listRecordings().length,
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
      if (res.writableEnded) {
        videoSubscribers.delete(res);
        continue;
      }
      // Skip this frame for slow clients instead of buffering delay.
      if (res.writableNeedDrain || res.writableLength > MAX_SUBSCRIBER_BUFFER_BYTES) continue;
      res.write(part);
    } catch {
      videoSubscribers.delete(res);
    }
  }
}

function broadcastAudioChunk(wssAudio, audioChunk) {
  for (const client of wssAudio.clients) {
    if (client.readyState === 1) {
      try {
        client.send(audioChunk, { binary: true });
      } catch {
        // ignore
      }
    }
  }
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use("/recordings", express.static(RECORDINGS_DIR));

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/admin", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

app.get("/videos", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "videos.html"));
});

app.get("/api/videos", (_req, res) => {
  res.json({ ok: true, items: listRecordings() });
});

app.post("/api/videos/:name/rename", (req, res) => {
  const oldName = normalizeVideoName(req.params?.name);
  const nextName = normalizeVideoName(req.body?.newName);
  if (!oldName || !nextName) {
    return res.status(400).json({ ok: false, error: "invalid filename" });
  }
  if (recordingProc && recordingName && (oldName === recordingName || nextName === recordingName)) {
    return res.status(409).json({ ok: false, error: "cannot rename active recording" });
  }
  const oldPath = path.join(RECORDINGS_DIR, oldName);
  const nextPath = path.join(RECORDINGS_DIR, nextName);
  if (oldPath === nextPath) return res.json({ ok: true, name: nextName });
  try {
    statSync(oldPath);
  } catch {
    return res.status(404).json({ ok: false, error: "video not found" });
  }
  try {
    statSync(nextPath);
    return res.status(409).json({ ok: false, error: "target name already exists" });
  } catch {
    // expected if destination does not exist
  }
  try {
    renameSync(oldPath, nextPath);
    return res.json({ ok: true, name: nextName });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err?.message ?? "rename failed" });
  }
});

app.delete("/api/videos/:name", (req, res) => {
  const name = normalizeVideoName(req.params?.name);
  if (!name) {
    return res.status(400).json({ ok: false, error: "invalid filename" });
  }
  if (recordingProc && recordingName && name === recordingName) {
    return res.status(409).json({ ok: false, error: "cannot delete active recording" });
  }
  const fullPath = path.join(RECORDINGS_DIR, name);
  try {
    unlinkSync(fullPath);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(404).json({ ok: false, error: err?.message ?? "delete failed" });
  }
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
      res.write(Buffer.concat([
        Buffer.from("--frame\r\nContent-Type: image/jpeg\r\n\r\n"),
        latestJpeg,
        Buffer.from("\r\n"),
      ]));
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
  if (action === "start") {
    streamActive = true;
    startRecording();
  } else if (action === "end" || action === "stop") {
    streamActive = false;
    stopRecording();
  }
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
const audioWss = new WebSocketServer({
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
  if (url === "/ws/audio") {
    audioWss.handleUpgrade(req, socket, head, (ws) => {
      audioWss.emit("connection", ws, req);
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

  ws.on("message", (raw, isBinary) => {
    if (isBinary) {
      try {
        stats.framesReceived += 1;
        latestJpeg = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
        latestFrameTs = Date.now();
        if (streamActive) broadcastFrame(latestJpeg);
        if (streamActive && recordingProc && !recordingProc.stdin.destroyed) {
          try {
            recordingProc.stdin.write(latestJpeg);
          } catch {
            // ignore recording write failures
          }
        }
      } catch {
        // ignore malformed binary frame
      }
      return;
    }
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
      audioConfig = {
        sampleRate: Number(msg.meta?.audioSampleRate ?? audioConfig.sampleRate ?? 48000),
        channels: Number(msg.meta?.audioChannels ?? audioConfig.channels ?? 1),
      };
      const cfgPayload = JSON.stringify({ type: "audioConfig", ...audioConfig });
      for (const client of audioWss.clients) {
        if (client.readyState === 1) {
          try {
            client.send(cfgPayload);
          } catch {
            // ignore
          }
        }
      }
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
        if (streamActive && recordingProc && !recordingProc.stdin.destroyed) {
          try {
            recordingProc.stdin.write(latestJpeg);
          } catch {
            // ignore recording write failures
          }
        }
      } catch {
        // ignore malformed frame
      }
      return;
    }
    if (msg.type === "audioPcm" && typeof msg.audioBase64 === "string") {
      try {
        const chunk = Buffer.from(msg.audioBase64, "base64");
        latestAudioTs = Number(msg.ts ?? Date.now());
        if (streamActive) broadcastAudioChunk(audioWss, chunk);
      } catch {
        // ignore malformed audio chunk
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

audioWss.on("connection", (ws) => {
  try {
    ws.send(JSON.stringify({ type: "audioConfig", ...audioConfig }));
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
  try {
    audioWss.close();
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
  stopRecording();
}

httpServer.listen(PORT, HOST, () => {
  console.log(`Reciever listening on http://127.0.0.1:${PORT}/`);
  console.log(`Waiting for encoder on ws://<this-host>:${PORT}${INGEST_PATH}`);
  if (streamActive) startRecording();
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
  if (latestAudioTs && Date.now() - latestAudioTs > 6000) {
    latestAudioTs = null;
  }
}, 2000);

// Keep UI freshness indicators updated even when upstream is quiet.
setInterval(() => {
  if (!shuttingDown) broadcastGps(gpsWss);
}, 1000);
