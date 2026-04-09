import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import net from "node:net";
import os from "node:os";

import { ReadlineParser } from "@serialport/parser-readline";
import ffmpegStatic from "ffmpeg-static";
import { SerialPort } from "serialport";
import WebSocket from "ws";

import { parseNmea } from "./lib/nmea.js";

const SERIAL_PATH = process.env.MONITOR_SERIAL_PORT ?? "/dev/serial0";
const SERIAL_BAUD = Number(process.env.MONITOR_SERIAL_BAUD ?? "115200");
const SERVO_A_PREFIX = process.env.MONITOR_SERVO_A_PREFIX ?? "servoA";
const SERVO_B_PREFIX = process.env.MONITOR_SERVO_B_PREFIX ?? "servoB";
const SERVO_MIN = Number(process.env.MONITOR_SERVO_MIN ?? "0");
const SERVO_MAX = Number(process.env.MONITOR_SERVO_MAX ?? "100");
const HOMING_SERVO_A = Number(process.env.MONITOR_HOMING_SERVO_A ?? "50");
const HOMING_SERVO_B = Number(process.env.MONITOR_HOMING_SERVO_B ?? "50");

const WEBCAM_INDEX = Number(process.env.MONITOR_WEBCAM_INDEX ?? "0");
const VIDEO_DEVICE = process.env.MONITOR_VIDEO_DEVICE ?? `/dev/video${WEBCAM_INDEX}`;
const AUDIO_DEVICE = process.env.MONITOR_AUDIO_DEVICE ?? "default";
const AUDIO_ENABLED_RAW = (process.env.MONITOR_AUDIO_ENABLED ?? "true").toLowerCase();
const AUDIO_ENABLED = !["0", "off", "false", "disable", "disabled"].includes(AUDIO_ENABLED_RAW);
const AUDIO_SAMPLE_RATE = Number(process.env.MONITOR_AUDIO_SAMPLE_RATE ?? "48000");
const AUDIO_CHANNELS = Number(process.env.MONITOR_AUDIO_CHANNELS ?? "1");
const AUDIO_CHUNK_SAMPLES = Number(process.env.MONITOR_AUDIO_CHUNK_SAMPLES ?? "1024");
const PERF_LOG_ENABLED_RAW = (process.env.MONITOR_PERF_LOG ?? "true").toLowerCase();
const PERF_LOG_ENABLED = !["0", "off", "false", "disable", "disabled"].includes(PERF_LOG_ENABLED_RAW);
const PERF_LOG_MS = Math.max(1000, Number(process.env.MONITOR_PERF_LOG_MS ?? "2000"));
const FRAME_WIDTH = Number(process.env.MONITOR_FRAME_WIDTH ?? "1280");
const FRAME_HEIGHT = Number(process.env.MONITOR_FRAME_HEIGHT ?? "720");
const TARGET_FPS = Number(process.env.MONITOR_CAMERA_FPS ?? "15");
const FRAME_SEND_CAP_FPS = Number(process.env.MONITOR_FRAME_SEND_CAP_FPS ?? "0");
const JPEG_QUALITY = Math.min(100, Math.max(1, Number(process.env.MONITOR_JPEG_QUALITY ?? "75")));
const MAX_UPSTREAM_BUFFER_BYTES = Number(process.env.MONITOR_MAX_UPSTREAM_BUFFER_BYTES ?? "262144");
const FFMPEG_PATH = process.env.MONITOR_FFMPEG_PATH ?? ffmpegStatic ?? "ffmpeg";

const RECEIVER_WS_URL = process.env.MONITOR_RECEIVER_WS_URL ?? "ws://127.0.0.1:9090/ingest";
const ENCODER_ID = process.env.MONITOR_ENCODER_ID ?? "pi-encoder";

function pickDefaultGpsPath() {
  const candidates = ["/dev/ttyACM0", "/dev/ttyUSB0"];
  for (const device of candidates) {
    if (existsSync(device)) return device;
  }
  return "/dev/ttyUSB0";
}

const GPS_PATH_RAW = (process.env.MONITOR_GPS_PATH ?? "").trim().toLowerCase();
let GPS_PATH = pickDefaultGpsPath();
if (GPS_PATH_RAW === "0" || GPS_PATH_RAW === "off" || GPS_PATH_RAW === "false" || GPS_PATH_RAW === "disable" || GPS_PATH_RAW === "disabled") {
  GPS_PATH = null;
} else if (process.env.MONITOR_GPS_PATH?.trim()) {
  GPS_PATH = process.env.MONITOR_GPS_PATH.trim();
}
const GPS_BAUD = Number(process.env.MONITOR_GPS_BAUD ?? "9600");
const GPS_SOURCE = (process.env.MONITOR_GPS_SOURCE ?? "auto").toLowerCase(); // auto|gpsd|serial
const GPSD_HOST = process.env.MONITOR_GPSD_HOST ?? "127.0.0.1";
const GPSD_PORT = Number(process.env.MONITOR_GPSD_PORT ?? "2947");

let shuttingDown = false;
let sentHoming = false;

function after(ms, fn) {
  return setTimeout(() => {
    if (!shuttingDown) fn();
  }, ms);
}

function clampServo(value) {
  return Math.min(SERVO_MAX, Math.max(SERVO_MIN, value));
}

function servoCommand(prefix, value) {
  return `${prefix}${clampServo(value)}`;
}

function jpegQv() {
  return Math.round(31 - (JPEG_QUALITY / 100) * 29);
}

let controlPort = null;
let controlWriteChain = Promise.resolve();

function connectControlLoop() {
  const tryOpen = () => {
    if (shuttingDown) return;
    console.log("Connecting to Arduino...");
    const p = new SerialPort({ path: SERIAL_PATH, baudRate: SERIAL_BAUD }, (err) => {
      if (err) {
        console.error("Serial connect failed:", err.message);
        p.removeAllListeners();
        try {
          if (p.isOpen) p.close();
          else if (typeof p.destroy === "function") p.destroy();
        } catch {
          // ignore
        }
        after(2000, tryOpen);
        return;
      }
      controlPort = p;
      console.log("Connected to serial OK");
      const parser = p.pipe(new ReadlineParser({ delimiter: "\n" }));
      parser.on("data", (line) => {
        const s = String(line).trim();
        if (s) console.log(`[ARDUINO] ${s}`);
      });
      p.on("error", () => reconnectControl());
      p.on("close", () => {
        if (!shuttingDown) reconnectControl();
      });
      if (!sentHoming) {
        sentHoming = true;
        sendServo(clampServo(HOMING_SERVO_A), clampServo(HOMING_SERVO_B));
      }
    });
  };
  tryOpen();
}

function reconnectControl() {
  const old = controlPort;
  controlPort = null;
  if (old) {
    old.removeAllListeners("close");
    old.removeAllListeners("error");
    if (old.isOpen) {
      try {
        old.close();
      } catch {
        // ignore
      }
    }
  }
  if (!shuttingDown) after(500, connectControlLoop);
}

function sendLine(line) {
  return new Promise((resolve) => {
    controlWriteChain = controlWriteChain.then(
      () =>
        new Promise((done) => {
          const p = controlPort;
          if (!p?.isOpen) {
            resolve({ ok: false, error: "Serial not connected" });
            done();
            return;
          }
          p.write(`${line.replace(/\r?\n/g, "")}\n`, (err) => {
            resolve({ ok: !err, error: err?.message ?? "" });
            done();
          });
        }),
    );
  });
}

async function sendServo(pan, tilt) {
  const a = await sendLine(servoCommand(SERVO_A_PREFIX, pan));
  const b = await sendLine(servoCommand(SERVO_B_PREFIX, tilt));
  return { ok: a.ok && b.ok, error: !a.ok ? a.error : b.error };
}

let gpsPort = null;
let gpsdSocket = null;
const gpsState = {
  lat: null,
  lon: null,
  alt: null,
  speedKmh: null,
  course: null,
  satellites: null,
  fix: null,
  hdop: null,
  time: null,
  date: null,
  updatedAt: null,
};

function gpsPublicJson() {
  const ok = gpsState.lat != null && gpsState.lon != null;
  return { ok, ...gpsState };
}

function mergeGpsState(patch) {
  if (!patch || typeof patch !== "object") return;
  Object.assign(gpsState, patch, { updatedAt: Date.now() });
  sendUpstream({ type: "gps", data: gpsPublicJson() });
}

function connectGpsd(onFailToSerial) {
  if (shuttingDown) return;
  console.log(`Connecting to gpsd (${GPSD_HOST}:${GPSD_PORT})...`);
  const sock = net.createConnection({ host: GPSD_HOST, port: GPSD_PORT });
  gpsdSocket = sock;
  let connected = false;
  let buf = "";

  sock.on("connect", () => {
    connected = true;
    // Enable JSON reports; poll every second.
    sock.write('?WATCH={"enable":true,"json":true};\n');
    console.log("gpsd connected");
  });

  sock.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    let i = buf.indexOf("\n");
    while (i >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      i = buf.indexOf("\n");
      if (!line.startsWith("{")) continue;
      let obj = null;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      if (!obj || typeof obj !== "object") continue;
      if (obj.class === "TPV") {
        const patch = {};
        if (Number.isFinite(obj.lat)) patch.lat = Number(obj.lat);
        if (Number.isFinite(obj.lon)) patch.lon = Number(obj.lon);
        if (Number.isFinite(obj.speed)) patch.speedKmh = Number(obj.speed) * 3.6;
        if (Number.isFinite(obj.track)) patch.course = Number(obj.track);
        if (Number.isFinite(obj.altMSL)) patch.alt = Number(obj.altMSL);
        else if (Number.isFinite(obj.alt)) patch.alt = Number(obj.alt);
        if (Number.isFinite(obj.mode)) patch.fix = Number(obj.mode) <= 1 ? 0 : Number(obj.mode);
        if (typeof obj.time === "string") patch.utc = obj.time;
        if (Number.isFinite(obj.eph)) patch.eph = Number(obj.eph);
        if (Number.isFinite(obj.epv)) patch.epv = Number(obj.epv);
        if (Number.isFinite(obj.sep)) patch.sep = Number(obj.sep);
        if (Number.isFinite(obj.eps)) patch.eps = Number(obj.eps);
        if (Number.isFinite(obj.magtrack)) patch.magtrack = Number(obj.magtrack);
        if (Number.isFinite(obj.magvar)) patch.magvar = Number(obj.magvar);
        mergeGpsState(patch);
      } else if (obj.class === "SKY") {
        const patch = {};
        if (Number.isFinite(obj.hdop)) patch.hdop = Number(obj.hdop);
        if (Number.isFinite(obj.pdop)) patch.pdop = Number(obj.pdop);
        if (Number.isFinite(obj.tdop)) patch.tdop = Number(obj.tdop);
        if (Number.isFinite(obj.vdop)) patch.vdop = Number(obj.vdop);
        if (Number.isFinite(obj.gdop)) patch.gdop = Number(obj.gdop);
        if (Number.isFinite(obj.nSat)) patch.nSat = Number(obj.nSat);
        if (Number.isFinite(obj.uSat)) patch.uSat = Number(obj.uSat);
        if (Array.isArray(obj.satellites)) patch.satellitesDetail = obj.satellites;
        if (Number.isFinite(obj.uSat)) patch.satellites = Number(obj.uSat);
        mergeGpsState(patch);
      }
    }
  });

  sock.on("error", (err) => {
    console.error("gpsd error:", err?.message ?? err);
  });

  sock.on("close", () => {
    gpsdSocket = null;
    if (shuttingDown) return;
    if (!connected && onFailToSerial) {
      console.log("gpsd unavailable, falling back to serial NMEA");
      onFailToSerial();
      return;
    }
    after(1500, () => connectGpsd(onFailToSerial));
  });
}

function connectGpsLoop() {
  if (!GPS_PATH || shuttingDown) return;
  const tryOpen = () => {
    if (shuttingDown || !GPS_PATH) return;
    console.log(`Connecting to GPS (${GPS_PATH} @ ${GPS_BAUD})...`);
    const p = new SerialPort({ path: GPS_PATH, baudRate: GPS_BAUD }, (err) => {
      if (err) {
        console.error("GPS serial failed:", err.message);
        after(3000, tryOpen);
        return;
      }
      gpsPort = p;
      console.log("GPS serial OK");
      const parser = p.pipe(new ReadlineParser({ delimiter: "\n" }));
      parser.on("data", (line) => {
        const patch = parseNmea(String(line));
        if (!patch) return;
        mergeGpsState(patch);
      });
      p.on("error", () => reconnectGps());
      p.on("close", () => {
        if (!shuttingDown) reconnectGps();
      });
    });
  };
  tryOpen();
}

function reconnectGps() {
  const old = gpsPort;
  gpsPort = null;
  if (old) {
    old.removeAllListeners("close");
    old.removeAllListeners("error");
    if (old.isOpen) {
      try {
        old.close();
      } catch {
        // ignore
      }
    }
  }
  if (!shuttingDown && GPS_PATH) after(500, connectGpsLoop);
}

const JPEG_SOI = Buffer.from([0xff, 0xd8]);
const JPEG_EOI = Buffer.from([0xff, 0xd9]);
let ffmpegProc = null;
let mjpegBuffer = Buffer.alloc(0);
let lastFrameSentAt = 0;
const FRAME_SEND_MS = FRAME_SEND_CAP_FPS > 0 ? Math.max(1, Math.round(1000 / Math.max(1, FRAME_SEND_CAP_FPS))) : 0;
let lastUpstreamDropLogAt = 0;
let ffmpegAudioProc = null;
const audioDeviceCandidates = (() => {
  const explicit = (process.env.MONITOR_AUDIO_DEVICE ?? "").trim();
  if (explicit) return [explicit];
  return ["default", "plughw:1,0", "hw:1,0"];
})();
let audioDeviceIndex = 0;
let audioStartupErrorCount = 0;
const perf = {
  frameDecoded: 0,
  frameSent: 0,
  frameDropped: 0,
  frameSkippedByCap: 0,
  frameBytesSent: 0,
  audioChunkSent: 0,
  audioBytes: 0,
  gpsSent: 0,
};

function fmtRatePerSec(value, secs) {
  return (secs > 0 ? value / secs : 0).toFixed(1);
}

function startFfmpeg() {
  if (shuttingDown || ffmpegProc) return;
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "v4l2",
    "-framerate",
    String(TARGET_FPS),
    "-video_size",
    `${FRAME_WIDTH}x${FRAME_HEIGHT}`,
    "-i",
    VIDEO_DEVICE,
    "-pix_fmt",
    "yuvj420p",
    "-q:v",
    String(jpegQv()),
    "-f",
    "image2pipe",
    "-vcodec",
    "mjpeg",
    "pipe:1",
  ];
  console.log("Starting FFmpeg:", FFMPEG_PATH, args.join(" "));
  ffmpegProc = spawn(FFMPEG_PATH, args, { stdio: ["ignore", "pipe", "pipe"] });
  ffmpegProc.stdout.on("data", onMjpegChunk);
  ffmpegProc.stderr.on("data", (b) => {
    const t = b.toString().trim();
    if (t) console.error("[ffmpeg]", t);
  });
  ffmpegProc.on("close", () => {
    ffmpegProc = null;
    mjpegBuffer = Buffer.alloc(0);
    if (!shuttingDown) after(1000, startFfmpeg);
  });
  ffmpegProc.on("error", () => {
    ffmpegProc = null;
    if (!shuttingDown) after(2000, startFfmpeg);
  });
}

function startFfmpegAudio() {
  if (!AUDIO_ENABLED || shuttingDown || ffmpegAudioProc) return;
  const audioInput = audioDeviceCandidates[Math.min(audioDeviceIndex, audioDeviceCandidates.length - 1)] ?? AUDIO_DEVICE;
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "alsa",
    "-i",
    audioInput,
    "-ac",
    String(AUDIO_CHANNELS),
    "-ar",
    String(AUDIO_SAMPLE_RATE),
    "-fflags",
    "nobuffer",
    "-flags",
    "low_delay",
    "-flush_packets",
    "1",
    "-f",
    "s16le",
    "pipe:1",
  ];
  console.log("Starting FFmpeg audio:", FFMPEG_PATH, args.join(" "));
  ffmpegAudioProc = spawn(FFMPEG_PATH, args, { stdio: ["ignore", "pipe", "pipe"] });
  let audioCarry = Buffer.alloc(0);
  const bytesPerSample = 2;
  const bytesPerChunk = Math.max(1, AUDIO_CHUNK_SAMPLES) * Math.max(1, AUDIO_CHANNELS) * bytesPerSample;
  ffmpegAudioProc.stdout.on("data", (chunk) => {
    if (!chunk?.length) return;
    audioCarry = Buffer.concat([audioCarry, chunk]);
    while (audioCarry.length >= bytesPerChunk) {
      const piece = audioCarry.subarray(0, bytesPerChunk);
      audioCarry = audioCarry.subarray(bytesPerChunk);
      sendUpstream({ type: "audioPcm", ts: Date.now(), audioBase64: piece.toString("base64") });
    }
  });
  ffmpegAudioProc.stderr.on("data", (b) => {
    const t = b.toString().trim();
    if (t) console.error("[ffmpeg-audio]", t);
  });
  ffmpegAudioProc.on("close", (code) => {
    ffmpegAudioProc = null;
    if (shuttingDown) return;
    const startupFailed = code !== 0;
    if (startupFailed && audioDeviceIndex < audioDeviceCandidates.length - 1) {
      audioDeviceIndex += 1;
      const nextInput = audioDeviceCandidates[audioDeviceIndex];
      console.warn(`Audio input failed, trying fallback device: ${nextInput}`);
      after(600, startFfmpegAudio);
      return;
    }
    if (startupFailed) {
      audioStartupErrorCount += 1;
      const waitMs = audioStartupErrorCount >= 5 ? 10000 : 2500;
      console.error(`Audio capture unavailable on ${audioInput}. Retrying in ${Math.round(waitMs / 1000)}s`);
      after(waitMs, startFfmpegAudio);
      return;
    }
    audioStartupErrorCount = 0;
    after(1200, startFfmpegAudio);
  });
  ffmpegAudioProc.on("error", () => {
    ffmpegAudioProc = null;
    if (!shuttingDown) after(2000, startFfmpegAudio);
  });
}

function onMjpegChunk(chunk) {
  mjpegBuffer = Buffer.concat([mjpegBuffer, chunk]);
  while (mjpegBuffer.length >= 4) {
    const start = mjpegBuffer.indexOf(JPEG_SOI);
    if (start === -1) {
      mjpegBuffer = mjpegBuffer.subarray(-1);
      break;
    }
    if (start > 0) mjpegBuffer = mjpegBuffer.subarray(start);
    const end = mjpegBuffer.indexOf(JPEG_EOI, 2);
    if (end === -1) break;
    const frame = mjpegBuffer.subarray(0, end + 2);
    mjpegBuffer = mjpegBuffer.subarray(end + 2);
    perf.frameDecoded += 1;
    const now = Date.now();
    if (FRAME_SEND_MS > 0 && now - lastFrameSentAt < FRAME_SEND_MS) {
      perf.frameSkippedByCap += 1;
      continue;
    }
    const ws = upstreamWs;
    if (!wsConnected || !ws || ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > MAX_UPSTREAM_BUFFER_BYTES) {
      perf.frameDropped += 1;
      if (now - lastUpstreamDropLogAt > 2000) {
        lastUpstreamDropLogAt = now;
        const queued = ws ? ws.bufferedAmount : 0;
        console.warn(`Dropping frame to keep realtime latency low (upstream queue=${queued}B)`);
      }
      continue;
    }
    lastFrameSentAt = now;
    perf.frameSent += 1;
    perf.frameBytesSent += frame.length;
    sendUpstreamFrame(frame);
  }
}

let upstreamWs = null;
let wsConnected = false;
let connectingUpstream = false;
let reconnectTimer = null;

function scheduleUpstreamReconnect(ms = 1500) {
  if (shuttingDown || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectUpstreamLoop();
  }, ms);
}

function connectUpstreamLoop() {
  if (shuttingDown || connectingUpstream) return;
  if (upstreamWs && (upstreamWs.readyState === WebSocket.OPEN || upstreamWs.readyState === WebSocket.CONNECTING)) {
    return;
  }
  connectingUpstream = true;
  console.log(`Connecting to reciever: ${RECEIVER_WS_URL}`);
  const ws = new WebSocket(RECEIVER_WS_URL, {
    perMessageDeflate: false,
  });
  upstreamWs = ws;
  ws.on("open", () => {
    connectingUpstream = false;
    wsConnected = true;
    sendUpstream({
      type: "hello",
      role: "encoder",
      encoderId: ENCODER_ID,
      meta: {
        videoDevice: VIDEO_DEVICE,
        gpsPath: GPS_PATH,
        gpsBaud: GPS_BAUD,
        audioSampleRate: AUDIO_SAMPLE_RATE,
        audioChannels: AUDIO_CHANNELS,
      },
    });
    perf.gpsSent += 1;
    sendUpstream({ type: "gps", data: gpsPublicJson() });
    console.log("Connected to reciever");
  });
  ws.on("message", async (raw) => {
    let msg = null;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "servo") {
      const pan = clampServo(Number(msg.pan ?? 50));
      const tilt = clampServo(Number(msg.tilt ?? 50));
      const out = await sendServo(pan, tilt);
      sendUpstream({ type: "servoAck", reqId: msg.reqId ?? null, ok: out.ok, error: out.error ?? null, pan, tilt });
    }
  });
  ws.on("close", () => {
    connectingUpstream = false;
    wsConnected = false;
    if (upstreamWs === ws) upstreamWs = null;
    scheduleUpstreamReconnect(1500);
  });
  ws.on("error", (err) => {
    // Wait for "close" to handle reconnect. Reconnecting here can create duplicate
    // concurrent sockets and causes connect/disconnect flapping.
    console.error("Upstream websocket error:", err?.message ?? err);
  });
}

function sendUpstream(obj) {
  const ws = upstreamWs;
  if (!ws || !wsConnected || ws.readyState !== WebSocket.OPEN) return;
  if (obj?.type === "audioPcm" && typeof obj.audioBase64 === "string") {
    perf.audioChunkSent += 1;
    perf.audioBytes += Math.floor((obj.audioBase64.length * 3) / 4);
  } else if (obj?.type === "gps") {
    perf.gpsSent += 1;
  }
  try {
    ws.send(JSON.stringify(obj));
  } catch {
    // ignore
  }
}

function sendUpstreamFrame(frameBuffer) {
  const ws = upstreamWs;
  if (!ws || !wsConnected || ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(frameBuffer, { binary: true });
  } catch {
    // ignore
  }
}

function destroySerial(sp) {
  if (!sp) return;
  try {
    sp.removeAllListeners("close");
    sp.removeAllListeners("error");
  } catch {
    // ignore
  }
  try {
    if (sp.isOpen) sp.close();
  } catch {
    // ignore
  }
  try {
    if (typeof sp.destroy === "function") sp.destroy();
  } catch {
    // ignore
  }
}

function shutdown() {
  shuttingDown = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  const ff = ffmpegProc;
  ffmpegProc = null;
  if (ff && !ff.killed) {
    try {
      ff.kill("SIGTERM");
    } catch {
      // ignore
    }
    setTimeout(() => {
      try {
        if (!ff.killed) ff.kill("SIGKILL");
      } catch {
        // ignore
      }
    }, 500);
  }
  const ffAudio = ffmpegAudioProc;
  ffmpegAudioProc = null;
  if (ffAudio && !ffAudio.killed) {
    try {
      ffAudio.kill("SIGTERM");
    } catch {
      // ignore
    }
    setTimeout(() => {
      try {
        if (!ffAudio.killed) ffAudio.kill("SIGKILL");
      } catch {
        // ignore
      }
    }, 500);
  }
  if (upstreamWs) {
    try {
      upstreamWs.close();
    } catch {
      // ignore
    }
  }
  if (gpsdSocket) {
    try {
      gpsdSocket.destroy();
    } catch {
      // ignore
    }
    gpsdSocket = null;
  }
  destroySerial(controlPort);
  destroySerial(gpsPort);
}

console.log(`Encoder starting (id: ${ENCODER_ID})`);
console.log(`Camera: ${VIDEO_DEVICE} ${FRAME_WIDTH}x${FRAME_HEIGHT}@${TARGET_FPS}`);
if (AUDIO_ENABLED) console.log(`Audio: ${AUDIO_DEVICE} ${AUDIO_CHANNELS}ch @ ${AUDIO_SAMPLE_RATE}Hz PCM`);
else console.log("Audio: disabled");
if (GPS_SOURCE === "gpsd") {
  console.log(`GPS source: gpsd ${GPSD_HOST}:${GPSD_PORT}`);
} else if (GPS_SOURCE === "serial") {
  if (GPS_PATH) console.log(`GPS source: serial ${GPS_PATH} @ ${GPS_BAUD}`);
  else console.log("GPS source: serial (disabled)");
} else {
  console.log(`GPS source: auto (gpsd ${GPSD_HOST}:${GPSD_PORT} then serial ${GPS_PATH ?? "disabled"})`);
}
if (PERF_LOG_ENABLED) console.log(`Perf log: every ${Math.round(PERF_LOG_MS / 1000)}s`);

connectControlLoop();
if (GPS_SOURCE === "gpsd") {
  connectGpsd();
} else if (GPS_SOURCE === "serial") {
  if (GPS_PATH) connectGpsLoop();
} else {
  // auto
  connectGpsd(() => {
    if (GPS_PATH) connectGpsLoop();
  });
}
startFfmpeg();
startFfmpegAudio();
connectUpstreamLoop();

if (PERF_LOG_ENABLED) {
  let lastPerfAt = Date.now();
  let lastCpuUsage = process.cpuUsage();
  setInterval(() => {
    if (shuttingDown) return;
    const now = Date.now();
    const elapsedSec = Math.max(0.001, (now - lastPerfAt) / 1000);
    lastPerfAt = now;
    const cpuUsageNow = process.cpuUsage();
    const cpuDeltaUser = cpuUsageNow.user - lastCpuUsage.user;
    const cpuDeltaSystem = cpuUsageNow.system - lastCpuUsage.system;
    lastCpuUsage = cpuUsageNow;
    const cpuPctSingleCore = ((cpuDeltaUser + cpuDeltaSystem) / (elapsedSec * 1e6)) * 100;
    const cpuPctAllCores = cpuPctSingleCore / Math.max(1, os.cpus().length);
    const load1 = os.loadavg()[0];
    const rssMb = process.memoryUsage().rss / (1024 * 1024);
    const ws = upstreamWs;
    const wsQueue = ws && ws.readyState === WebSocket.OPEN ? ws.bufferedAmount : 0;
    const vKbps = ((perf.frameBytesSent * 8) / 1000) / elapsedSec;
    const aKbps = ((perf.audioBytes * 8) / 1000) / elapsedSec;
    console.log(
      `[PERF] inFPS=${fmtRatePerSec(perf.frameDecoded, elapsedSec)} outFPS=${fmtRatePerSec(perf.frameSent, elapsedSec)} ` +
      `dropFPS=${fmtRatePerSec(perf.frameDropped, elapsedSec)} capSkipFPS=${fmtRatePerSec(perf.frameSkippedByCap, elapsedSec)} ` +
      `vKbps=${vKbps.toFixed(0)} aKbps=${aKbps.toFixed(0)} ` +
      `gps/s=${fmtRatePerSec(perf.gpsSent, elapsedSec)} wsQ=${wsQueue}B ` +
      `cpu1=${cpuPctSingleCore.toFixed(1)}% cpuAll=${cpuPctAllCores.toFixed(1)}% load1=${load1.toFixed(2)} rss=${rssMb.toFixed(0)}MB`,
    );
    perf.frameDecoded = 0;
    perf.frameSent = 0;
    perf.frameDropped = 0;
    perf.frameSkippedByCap = 0;
    perf.frameBytesSent = 0;
    perf.audioChunkSent = 0;
    perf.audioBytes = 0;
    perf.gpsSent = 0;
  }, PERF_LOG_MS);
}

let signalCount = 0;
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    signalCount += 1;
    if (signalCount > 1) process.exit(1);
    shutdown();
    setTimeout(() => process.exit(0), 1000);
  });
}
