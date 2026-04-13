import { createServer } from "node:http";
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import crypto from "node:crypto";

import express from "express";
import { WebSocketServer, WebSocket } from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const HOST = process.env.MONITOR_HOST ?? "0.0.0.0";
const PORT = Number(process.env.MONITOR_PORT ?? "9090");
const INGEST_PATH = process.env.MONITOR_INGEST_PATH ?? "/ingest";
const RECORDINGS_DIR = process.env.MONITOR_RECORDINGS_DIR
  ? path.resolve(process.env.MONITOR_RECORDINGS_DIR)
  : path.join(__dirname, "recordings");
/** Must match encoder `VIDEO_FPS` (MJPEG → MP4). */
const VIDEO_FPS = 30;
const FFMPEG_BIN = process.env.MONITOR_FFMPEG_PATH ?? "ffmpeg";
const ADMIN_ALLOWED_EMAILS = new Set(
  String(process.env.MONITOR_ADMIN_ALLOWED_EMAILS ?? "xmicroninjax@gmail.com")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);
const ADMIN_SESSION_TTL_MS = Number(process.env.MONITOR_ADMIN_SESSION_TTL_MS ?? String(12 * 60 * 60 * 1000));
const GOOGLE_CLIENT_ID = String(process.env.MONITOR_GOOGLE_CLIENT_ID ?? "").trim();

let shuttingDown = false;

let encoderSocket = null;
let encoderMeta = null;
let latestJpeg = null;
let latestFrameTs = null;
let latestAudioTs = null;
let audioConfig = { sampleRate: 48000, channels: 1 };
let streamActive = false;
/** When admin started the live stream; null while stream is off (admin Uptime). */
let streamStartedAt = null;
let recordingProc = null;
let recordingName = null;
let recordingStartedAt = null;
let recordingAudioPadTimer = null;
let lastRecordingAudioWriteMs = 0;
const adminPreviewSubscribers = new Set();
const adminSessions = new Map();
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
/** Cap Node write buffer per viewer; lower = less backlog on slow/long-RTT links (more dropped frames). */
const MAX_SUBSCRIBER_BUFFER_BYTES = Math.max(
  8192,
  Number(process.env.MONITOR_SUBSCRIBER_MAX_BUFFER_BYTES ?? "98304"),
);
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

const SERVO_CONFIG_PATH = path.join(__dirname, "servo-config.json");
const DEFAULT_SERVO_CONFIG = {
  panMin: 0,
  panMax: 100,
  tiltMin: 0,
  tiltMax: 100,
  presets: {
    forward: { pan: 66, tilt: 50 },
    backward: { pan: 13, tilt: 50 },
    left: { pan: 40, tilt: 50 },
    right: { pan: 92, tilt: 50 },
  },
};
/** @type {{ panMin: number; panMax: number; tiltMin: number; tiltMax: number; presets: Record<string, { pan: number; tilt: number }> }} */
let servoConfig;

function clampIntServoAxis(n, lo, hi) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return lo;
  return Math.max(lo, Math.min(hi, v));
}

function normalizeServoConfig(body) {
  const d = DEFAULT_SERVO_CONFIG;
  let panMin = clampIntServoAxis(body?.panMin ?? d.panMin, 0, 100);
  let panMax = clampIntServoAxis(body?.panMax ?? d.panMax, 0, 100);
  let tiltMin = clampIntServoAxis(body?.tiltMin ?? d.tiltMin, 0, 100);
  let tiltMax = clampIntServoAxis(body?.tiltMax ?? d.tiltMax, 0, 100);
  if (panMin > panMax) [panMin, panMax] = [panMax, panMin];
  if (tiltMin > tiltMax) [tiltMin, tiltMax] = [tiltMax, tiltMin];
  const presets = {};
  const names = ["forward", "backward", "left", "right"];
  const src = body?.presets && typeof body.presets === "object" ? body.presets : d.presets;
  for (const key of names) {
    const def = d.presets[key];
    const p = src[key] && typeof src[key] === "object" ? src[key] : def;
    presets[key] = {
      pan: clampIntServoAxis(p?.pan ?? def.pan, panMin, panMax),
      tilt: clampIntServoAxis(p?.tilt ?? def.tilt, tiltMin, tiltMax),
    };
  }
  return { panMin, panMax, tiltMin, tiltMax, presets };
}

function servoConfigPublicJson() {
  return {
    panMin: servoConfig.panMin,
    panMax: servoConfig.panMax,
    tiltMin: servoConfig.tiltMin,
    tiltMax: servoConfig.tiltMax,
    presets: { ...servoConfig.presets },
  };
}

function loadServoConfigFromDisk() {
  try {
    const raw = JSON.parse(readFileSync(SERVO_CONFIG_PATH, "utf8"));
    servoConfig = normalizeServoConfig(raw);
  } catch {
    servoConfig = normalizeServoConfig({ ...DEFAULT_SERVO_CONFIG, presets: { ...DEFAULT_SERVO_CONFIG.presets } });
  }
}

function persistServoConfig() {
  writeFileSync(SERVO_CONFIG_PATH, `${JSON.stringify(servoConfig, null, 2)}\n`, "utf8");
}

loadServoConfigFromDisk();

/** Last acknowledged pan/tilt from a successful /api/servo (shown to new / page loads). */
let lastServoPan;
let lastServoTilt;
function resetLastServoToConfigCenter() {
  lastServoPan = Math.round((servoConfig.panMin + servoConfig.panMax) / 2);
  lastServoTilt = Math.round((servoConfig.tiltMin + servoConfig.tiltMax) / 2);
}
function clampLastServoToConfig() {
  lastServoPan = clampIntServoAxis(lastServoPan, servoConfig.panMin, servoConfig.panMax);
  lastServoTilt = clampIntServoAxis(lastServoTilt, servoConfig.tiltMin, servoConfig.tiltMax);
}
resetLastServoToConfigCenter();

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

function recordingSilenceChunkBytes() {
  const sr = Math.max(8000, Number(audioConfig.sampleRate) || 48000);
  const ch = Math.min(2, Math.max(1, Number(audioConfig.channels) || 1));
  const samples = Math.max(64, Math.floor(sr / 50));
  return Buffer.alloc(samples * ch * 2, 0);
}

function recordingPadAudioIfIdle() {
  const proc = recordingProc;
  const audioIn = proc?.stdio?.[3];
  if (!audioIn || audioIn.destroyed) return;
  const now = Date.now();
  if (now - lastRecordingAudioWriteMs < 40) return;
  try {
    audioIn.write(recordingSilenceChunkBytes());
    lastRecordingAudioWriteMs = now;
  } catch {
    // ignore
  }
}

function startRecording() {
  if (!streamActive || recordingProc) return;
  const outName = recordingPathForNow();
  const outPath = path.join(RECORDINGS_DIR, outName);
  const sr = Math.max(8000, Number(audioConfig.sampleRate) || 48000);
  const ch = Math.min(2, Math.max(1, Number(audioConfig.channels) || 1));
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "mjpeg",
    "-framerate",
    String(VIDEO_FPS),
    "-i",
    "pipe:0",
    "-f",
    "s16le",
    "-ar",
    String(sr),
    "-ac",
    String(ch),
    "-i",
    "pipe:3",
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-pix_fmt",
    "yuv420p",
    "-r",
    String(VIDEO_FPS),
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-movflags",
    "+faststart",
    outPath,
  ];
  const proc = spawn(FFMPEG_BIN, args, { stdio: ["pipe", "ignore", "pipe", "pipe"] });
  recordingProc = proc;
  recordingName = outName;
  recordingStartedAt = Date.now();
  lastRecordingAudioWriteMs = 0;
  if (recordingAudioPadTimer) {
    clearInterval(recordingAudioPadTimer);
    recordingAudioPadTimer = null;
  }
  recordingAudioPadTimer = setInterval(recordingPadAudioIfIdle, 25);
  proc.stderr.on("data", (b) => {
    const t = b.toString().trim();
    if (t) console.error("[recording ffmpeg]", t);
  });
  proc.on("close", () => {
    if (recordingAudioPadTimer) {
      clearInterval(recordingAudioPadTimer);
      recordingAudioPadTimer = null;
    }
    recordingProc = null;
    recordingName = null;
    recordingStartedAt = null;
  });
  proc.on("error", (err) => {
    if (recordingAudioPadTimer) {
      clearInterval(recordingAudioPadTimer);
      recordingAudioPadTimer = null;
    }
    console.error("Recording process error:", err?.message ?? err);
  });
  console.log(`Recording started: ${outName} @ ${VIDEO_FPS}fps + ${ch}ch@${sr}Hz audio`);
}

function stopRecording() {
  const proc = recordingProc;
  if (!proc) return;
  if (recordingAudioPadTimer) {
    clearInterval(recordingAudioPadTimer);
    recordingAudioPadTimer = null;
  }
  try {
    proc.stdin.end();
  } catch {
    // ignore
  }
  try {
    const audioIn = proc.stdio?.[3];
    if (audioIn && !audioIn.destroyed) audioIn.end();
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

function parseCookies(req) {
  const out = {};
  const raw = String(req.headers?.cookie ?? "");
  if (!raw) return out;
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    const key = part.slice(0, i).trim();
    const val = part.slice(i + 1).trim();
    if (!key) continue;
    out[key] = decodeURIComponent(val);
  }
  return out;
}

function sessionCookieValue(req) {
  return parseCookies(req).admin_session ?? "";
}

function isAdminSessionValid(req) {
  const token = sessionCookieValue(req);
  if (!token) return false;
  const exp = adminSessions.get(token);
  if (!exp || exp < Date.now()) {
    if (exp) adminSessions.delete(token);
    return false;
  }
  adminSessions.set(token, Date.now() + ADMIN_SESSION_TTL_MS);
  return true;
}

function issueAdminSession(res) {
  const token = crypto.randomBytes(32).toString("hex");
  adminSessions.set(token, Date.now() + ADMIN_SESSION_TTL_MS);
  const maxAgeSec = Math.floor(ADMIN_SESSION_TTL_MS / 1000);
  res.setHeader("Set-Cookie", `admin_session=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAgeSec}`);
}

function clearAdminSession(req, res) {
  const token = sessionCookieValue(req);
  if (token) adminSessions.delete(token);
  res.setHeader("Set-Cookie", "admin_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0");
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
    servoConfig: servoConfigPublicJson(),
    servoPan: lastServoPan,
    servoTilt: lastServoTilt,
  };
}

function adminStatsJson() {
  const recordings = listRecordings();
  const recordingsSig = recordings.map((r) => `${r.name}:${r.sizeBytes}`).join("|");
  const base = gpsJson();
  const streamUptimeMs =
    streamActive && streamStartedAt != null ? Math.max(0, Date.now() - streamStartedAt) : 0;
  const fpsApprox = base.frameAgeMs != null && base.frameAgeMs <= 2000 ? Math.max(0, Math.round(1000 / Math.max(base.frameAgeMs, 1))) : 0;
  return {
    uptimeMs: streamUptimeMs,
    streamActive,
    videoSubscribers: videoSubscribers.size,
    ...stats,
    fpsApprox,
    recordingActive: !!recordingProc,
    recordingName,
    recordingStartedAt,
    recordingsCount: recordings.length,
    recordings,
    recordingsSig,
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

function broadcastMultipartJpeg(jpeg, subscribers) {
  const part = Buffer.concat([
    Buffer.from("--frame\r\nContent-Type: image/jpeg\r\n\r\n"),
    jpeg,
    Buffer.from("\r\n"),
  ]);
  for (const res of subscribers) {
    try {
      if (res.writableEnded) {
        subscribers.delete(res);
        continue;
      }
      // Skip this frame for slow clients instead of buffering delay.
      if (res.writableNeedDrain || res.writableLength > MAX_SUBSCRIBER_BUFFER_BYTES) continue;
      res.write(part);
    } catch {
      subscribers.delete(res);
    }
  }
}

function broadcastFrame(jpeg) {
  broadcastMultipartJpeg(jpeg, videoSubscribers);
}

function broadcastAdminPreviewFrame(jpeg) {
  broadcastMultipartJpeg(jpeg, adminPreviewSubscribers);
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
  if (!isAdminSessionValid(_req)) return res.redirect(302, "/admin/login");
  return res.sendFile(path.join(__dirname, "public", "admin.html"));
});

app.get("/admin/login", (_req, res) => {
  if (isAdminSessionValid(_req)) return res.redirect(302, "/admin");
  const tplPath = path.join(__dirname, "public", "admin-login.html");
  let html = "";
  try {
    html = readFileSync(tplPath, "utf8");
  } catch {
    return res.status(500).send("Admin login page unavailable.");
  }
  html = html.replace('data-client_id=""', `data-client_id="${GOOGLE_CLIENT_ID}"`);
  return res.type("html").send(html);
});

app.get("/videos", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "videos.html"));
});

app.get("/api/videos", (_req, res) => {
  res.json({ ok: true, items: listRecordings() });
});

app.post("/api/videos/:name/rename", (req, res) => {
  if (!isAdminSessionValid(req)) return res.status(401).json({ ok: false, error: "admin auth required" });
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
  if (!isAdminSessionValid(req)) return res.status(401).json({ ok: false, error: "admin auth required" });
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
    // nginx: disable response buffering for this long-lived stream
    "X-Accel-Buffering": "no",
  });
  try {
    res.socket?.setNoDelay(true);
  } catch {
    // ignore
  }
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

app.get("/api/admin/camera_feed", (req, res) => {
  if (!isAdminSessionValid(req)) return res.status(401).send("admin auth required");
  res.writeHead(200, {
    "Content-Type": "multipart/x-mixed-replace; boundary=frame",
    "Cache-Control": "no-cache, no-store, must-revalidate",
    Pragma: "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  try {
    res.socket?.setNoDelay(true);
  } catch {
    // ignore
  }
  adminPreviewSubscribers.add(res);
  if (latestJpeg) {
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
    adminPreviewSubscribers.delete(res);
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

app.get("/api/servo-config", (_req, res) => {
  res.json({ ok: true, ...servoConfigPublicJson(), servoPan: lastServoPan, servoTilt: lastServoTilt });
});

app.put("/api/admin/servo-config", (req, res) => {
  if (!isAdminSessionValid(req)) return res.status(401).json({ ok: false, error: "admin auth required" });
  servoConfig = normalizeServoConfig(req.body ?? {});
  clampLastServoToConfig();
  try {
    persistServoConfig();
  } catch (err) {
    console.error("servo-config persist failed:", err?.message ?? err);
  }
  broadcastGps(gpsWss);
  return res.json({ ok: true, ...servoConfigPublicJson() });
});

app.get("/api/admin/stats", (_req, res) => {
  if (!isAdminSessionValid(_req)) return res.status(401).json({ ok: false, error: "admin auth required" });
  res.json(adminStatsJson());
});

app.post("/api/admin/stream", (req, res) => {
  if (!isAdminSessionValid(req)) return res.status(401).json({ ok: false, error: "admin auth required" });
  const action = String(req.body?.action ?? "").toLowerCase();
  if (action === "start") {
    streamActive = true;
    streamStartedAt = Date.now();
    startRecording();
  } else if (action === "end" || action === "stop") {
    streamActive = false;
    streamStartedAt = null;
    stopRecording();
  }
  else return res.status(400).json({ ok: false, error: "action must be start or end" });
  return res.json({ ok: true, streamActive });
});

app.post("/api/admin/auth/google", async (req, res) => {
  const idToken = String(req.body?.idToken ?? "").trim();
  if (!idToken) return res.status(400).json({ ok: false, error: "idToken required" });
  try {
    const r = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
    if (!r.ok) return res.status(401).json({ ok: false, error: "invalid google token" });
    const info = await r.json();
    const email = String(info?.email ?? "").toLowerCase();
    const verified = String(info?.email_verified ?? "").toLowerCase() === "true";
    if (!verified || !ADMIN_ALLOWED_EMAILS.has(email)) {
      return res.status(403).json({ ok: false, error: "google account not allowed" });
    }
    issueAdminSession(res);
    return res.json({ ok: true, email });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err?.message ?? "auth failed" });
  }
});

app.post("/api/admin/logout", (req, res) => {
  clearAdminSession(req, res);
  res.json({ ok: true });
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
  const { panMin, panMax, tiltMin, tiltMax } = servoConfig;
  const pan = clampIntServoAxis(panRaw, panMin, panMax);
  const tilt = clampIntServoAxis(tiltRaw, tiltMin, tiltMax);
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
    lastServoPan = pan;
    lastServoTilt = tilt;
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
httpServer.on("connection", (socket) => {
  try {
    socket.setNoDelay(true);
  } catch {
    // ignore
  }
});
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
const adminWss = new WebSocketServer({
  noServer: true,
  perMessageDeflate: false,
});

adminWss.on("connection", (ws) => {
  const tick = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(adminStatsJson()));
    } catch {
      // ignore
    }
  }, 1000);
  ws.on("close", () => clearInterval(tick));
});

httpServer.on("upgrade", (req, socket, head) => {
  const url = req.url || "";
  const pathOnly = url.split("?")[0] || "";
  if (pathOnly === "/ws/admin") {
    if (!isAdminSessionValid(req)) {
      try {
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      } catch {
        // ignore
      }
      socket.destroy();
      return;
    }
    adminWss.handleUpgrade(req, socket, head, (ws) => {
      adminWss.emit("connection", ws, req);
    });
    return;
  }
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
        broadcastAdminPreviewFrame(latestJpeg);
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
        broadcastAdminPreviewFrame(latestJpeg);
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
        const audioIn = recordingProc?.stdio?.[3];
        if (streamActive && recordingProc && audioIn && !audioIn.destroyed) {
          try {
            audioIn.write(chunk);
            lastRecordingAudioWriteMs = Date.now();
          } catch {
            // ignore recording audio write failures
          }
        }
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
      latestJpeg = null;
      latestFrameTs = null;
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
  for (const res of adminPreviewSubscribers) {
    try {
      res.end();
    } catch {
      // ignore
    }
  }
  adminPreviewSubscribers.clear();
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
  console.log(`MJPEG subscriber buffer cap: ${MAX_SUBSCRIBER_BUFFER_BYTES}B per viewer (set MONITOR_SUBSCRIBER_MAX_BUFFER_BYTES)`);
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
