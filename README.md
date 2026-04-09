# Split Architecture

This project is now split into two services:

- `encoder/` - runs on the Raspberry Pi, talks to hardware (camera, GPS, servos), and pushes telemetry/video upstream.
- `reciever/` - hosts the web UI, receives encoder data, and sends servo commands back to the encoder.

## 1) Start the reciever

```bash
cd reciever
npm install
npm start
```

Defaults:

- UI: `http://127.0.0.1:9090/`
- ingest websocket for encoder: `ws://<reciever-host>:9090/ingest`

## 2) Start the encoder (on Pi)

```bash
cd encoder
npm install
MONITOR_RECEIVER_WS_URL=ws://<reciever-host>:9090/ingest npm start
```

Useful encoder env vars:

- `MONITOR_SERIAL_PORT` (default `/dev/serial0`)
- `MONITOR_GPS_PATH` (auto-picks `/dev/ttyACM0` or `/dev/ttyUSB0`)
- `MONITOR_VIDEO_DEVICE` (default `/dev/video0`)
- `MONITOR_AUDIO_ENABLED` (default `true`)
- `MONITOR_AUDIO_DEVICE` (ALSA input, default `default`)
- `MONITOR_AUDIO_SAMPLE_RATE`, `MONITOR_AUDIO_CHANNELS`, `MONITOR_AUDIO_BITRATE` (defaults `44100`, `1`, `96k`)
- `MONITOR_HOMING_SERVO_A`, `MONITOR_HOMING_SERVO_B` (defaults `50`, `50`)

Servo protocol remains:

- pan: `servoA0` .. `servoA100`
- tilt: `servoB0` .. `servoB100`

## Docker / GHCR

Pushing a git tag `v1.0.0` builds and pushes two images (amd64 + arm64):

- `ghcr.io/<your-github-username>/skate-streamer-reciever:v1.0.0` (and `:latest`)
- `ghcr.io/<your-github-username>/skate-streamer-encoder:v1.0.0` (and `:latest`)

Receiver example (recordings on a volume at `/data`):

```bash
docker run -d --name reciever -p 9090:9090 \
  -v skate-recordings:/data \
  -e MONITOR_GOOGLE_CLIENT_ID="..." \
  -e MONITOR_ADMIN_ALLOWED_EMAILS="you@example.com" \
  -e MONITOR_RECORDINGS_DIR=/data/recordings \
  ghcr.io/<owner>/skate-streamer-reciever:v1.0.0
```

Encoder example (point at the receiver, pass through camera / serial as needed):

```bash
docker run -d --name encoder --restart unless-stopped \
  -e MONITOR_RECEIVER_WS_URL=ws://reciever-host:9090/ingest \
  --device /dev/video0 \
  ghcr.io/<owner>/skate-streamer-encoder:v1.0.0
```

See `reciever/.env.example` for all receiver environment variables.
