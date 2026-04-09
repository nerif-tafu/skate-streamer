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
