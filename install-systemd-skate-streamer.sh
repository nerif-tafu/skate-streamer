#!/usr/bin/env bash
# Install a systemd user service that, on each start (including boot), runs
# `git pull --ff-only` in this repository, then starts the receiver (Node).
#
# Requirements on the host: git, node (v20+), npm deps installed once (`npm ci`
# in reciever/), ffmpeg in PATH for recordings. For private repos, configure
# git credentials (SSH key or credential helper) for the service user.
#
# Usage (from repo root, on Linux):
#   chmod +x install-systemd-skate-streamer.sh
#   ./install-systemd-skate-streamer.sh
#   # or with options:
#   sudo SKATE_SERVICE_USER=deploy ./install-systemd-skate-streamer.sh
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RECEIVER_DIR="${SKATE_RECEIVER_DIR:-$REPO_ROOT/reciever}"
SERVICE_NAME="${SKATE_SYSTEMD_UNIT:-skate-streamer-receiver}"
NODE_BIN="${SKATE_NODE_BIN:-$(command -v node || true)}"
SERVICE_USER="${SKATE_SERVICE_USER:-${SUDO_USER:-$USER}}"
SYSTEMD_DIR="/etc/systemd/system"
UNIT_PATH="${SYSTEMD_DIR}/${SERVICE_NAME}.service"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run as root so the unit can be installed under ${SYSTEMD_DIR} (e.g. sudo $0)" >&2
  exit 1
fi

if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
  echo "Node.js not found. Set SKATE_NODE_BIN to the node binary path." >&2
  exit 1
fi

if [[ ! -f "$RECEIVER_DIR/server.js" ]]; then
  echo "Receiver not found at $RECEIVER_DIR (expected server.js)." >&2
  exit 1
fi

if ! id -u "$SERVICE_USER" &>/dev/null; then
  echo "User does not exist: $SERVICE_USER" >&2
  exit 1
fi

if [[ "$SERVICE_USER" == "root" ]]; then
  echo "Warning: service User=root. Prefer SKATE_SERVICE_USER=deploy (or similar) with a normal account." >&2
fi

# The service user must be able to write to .git (for git pull) and read the tree.
# Clone the repo as that user, or adjust ownership (e.g. chown -R user:group "$REPO_ROOT").

cat >"/tmp/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=Skate Streamer receiver (git pull then Node)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=$(id -gn "$SERVICE_USER")
WorkingDirectory=${RECEIVER_DIR}
Environment=NODE_ENV=production
# Optional: KEY=value lines (same rules as systemd EnvironmentFile)
EnvironmentFile=-${RECEIVER_DIR}/.env
# Pull updates before start; leading '-' ignores failure (e.g. offline) so the service still starts
ExecStartPre=-/usr/bin/git -C ${REPO_ROOT} pull --ff-only
ExecStart=${NODE_BIN} ${RECEIVER_DIR}/server.js
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${SERVICE_NAME}

[Install]
WantedBy=multi-user.target
EOF

install -m 644 "/tmp/${SERVICE_NAME}.service" "$UNIT_PATH"
rm -f "/tmp/${SERVICE_NAME}.service"

systemctl daemon-reload
systemctl enable "${SERVICE_NAME}.service"
systemctl restart "${SERVICE_NAME}.service"

echo "Installed ${UNIT_PATH}"
echo "Status: systemctl status ${SERVICE_NAME}.service"
echo "Logs:   journalctl -u ${SERVICE_NAME}.service -f"
