#!/usr/bin/env bash
# Install a systemd unit (on the Pi) that runs `git pull --ff-only` in this repo,
# then starts the encoder (camera, GPS, servos → upstream receiver).
#
# Requirements: git, Node (v20+), `npm ci` once in encoder/, serial/GPS/camera access
# for the service user. For private repos, configure git credentials for that user.
#
# This does NOT install the receiver — run that on your server separately (e.g. npm / Docker).
#
# Usage (from repo root, on Linux):
#   chmod +x install-systemd-skate-streamer.sh
#   sudo ./install-systemd-skate-streamer.sh
#   sudo SKATE_NODE_BIN=/path/to/node ./install-systemd-skate-streamer.sh
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENCODER_DIR="${SKATE_ENCODER_DIR:-$REPO_ROOT/encoder}"
SERVICE_NAME="${SKATE_SYSTEMD_UNIT:-skate-streamer-encoder}"
SERVICE_USER="${SKATE_SERVICE_USER:-${SUDO_USER:-$USER}}"
SYSTEMD_DIR="/etc/systemd/system"
UNIT_PATH="${SYSTEMD_DIR}/${SERVICE_NAME}.service"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run as root so the unit can be installed under ${SYSTEMD_DIR} (e.g. sudo $0)" >&2
  exit 1
fi

# Under `sudo`, root's PATH usually omits nvm/fnm; resolve node as the invoking user or common locations.
resolve_node_bin() {
  if [[ -n "${SKATE_NODE_BIN:-}" ]]; then
    printf '%s' "$SKATE_NODE_BIN"
    return 0
  fi
  local candidate=""
  if [[ -n "${SUDO_USER:-}" ]] && id -u "$SUDO_USER" &>/dev/null; then
    local su_home
    su_home="$(getent passwd "$SUDO_USER" | cut -d: -f6)"
    if [[ -n "$su_home" && -s "${su_home}/.nvm/nvm.sh" ]]; then
      if command -v runuser &>/dev/null; then
        candidate="$(runuser -u "$SUDO_USER" -- env HOME="${su_home}" bash -c '. "${HOME}/.nvm/nvm.sh" 2>/dev/null; command -v node' 2>/dev/null || true)"
      else
        candidate="$(su - "$SUDO_USER" -s /bin/bash -c '. "${HOME}/.nvm/nvm.sh" 2>/dev/null; command -v node' 2>/dev/null || true)"
      fi
      if [[ -n "$candidate" && -x "$candidate" ]]; then
        printf '%s' "$candidate"
        return 0
      fi
    fi
    if [[ -n "$su_home" ]]; then
      local -a nvm_nodes
      shopt -s nullglob
      nvm_nodes=("${su_home}/.nvm/versions/node/v"*/bin/node)
      shopt -u nullglob
      if ((${#nvm_nodes[@]} > 0)); then
        local nvm_pick
        nvm_pick="$(printf '%s\n' "${nvm_nodes[@]}" | LC_ALL=C sort -V | tail -n1)"
        if [[ -x "$nvm_pick" ]]; then
          printf '%s' "$nvm_pick"
          return 0
        fi
      fi
    fi
    if command -v runuser &>/dev/null; then
      candidate="$(runuser -u "$SUDO_USER" -- /bin/bash -l -c 'command -v node' 2>/dev/null || true)"
      if [[ -n "$candidate" && -x "$candidate" ]]; then
        printf '%s' "$candidate"
        return 0
      fi
      candidate="$(runuser -u "$SUDO_USER" -- /bin/bash -ic 'command -v node' 2>/dev/null || true)"
      if [[ -n "$candidate" && -x "$candidate" ]]; then
        printf '%s' "$candidate"
        return 0
      fi
      candidate="$(runuser -u "$SUDO_USER" -- env PATH="/usr/local/bin:/usr/bin:/bin:${PATH:-}" command -v node 2>/dev/null || true)"
      if [[ -n "$candidate" && -x "$candidate" ]]; then
        printf '%s' "$candidate"
        return 0
      fi
    else
      candidate="$(su - "$SUDO_USER" -s /bin/bash -l -c 'command -v node' 2>/dev/null || true)"
      if [[ -n "$candidate" && -x "$candidate" ]]; then
        printf '%s' "$candidate"
        return 0
      fi
    fi
  fi
  candidate="$(command -v node 2>/dev/null || true)"
  if [[ -n "$candidate" && -x "$candidate" ]]; then
    printf '%s' "$candidate"
    return 0
  fi
  for candidate in /usr/bin/node /usr/local/bin/node; do
    if [[ -x "$candidate" ]]; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  return 1
}

NODE_BIN=""
if ! NODE_BIN="$(resolve_node_bin)"; then
  echo "Node.js not found for root or for user ${SUDO_USER:-<none>}." >&2
  echo "Set SKATE_NODE_BIN to the full path to node (e.g. output of: which node)" >&2
  exit 1
fi

if [[ ! -x "$NODE_BIN" ]]; then
  echo "Node binary not executable: $NODE_BIN" >&2
  exit 1
fi

echo "Using Node: $NODE_BIN"

if [[ ! -f "${ENCODER_DIR}/encoder.js" ]]; then
  echo "Encoder not found at ${ENCODER_DIR} (expected encoder.js)." >&2
  exit 1
fi

if ! id -u "$SERVICE_USER" &>/dev/null; then
  echo "User does not exist: $SERVICE_USER" >&2
  exit 1
fi

if [[ "$SERVICE_USER" == "root" ]]; then
  echo "Warning: service User=root. Prefer SKATE_SERVICE_USER=finn-rm (or similar) with a normal account." >&2
fi

# Match `npm start` in encoder/: Node loads encoder/.env via --env-file.
NODE_ENVFILE_ARG=""
if [[ -f "${ENCODER_DIR}/.env" ]]; then
  NODE_ENVFILE_ARG="--env-file=${ENCODER_DIR}/.env "
else
  echo "Warning: no ${ENCODER_DIR}/.env — copy encoder/.env.example if present, set MONITOR_RECEIVER_WS_URL, then re-run or restart the unit." >&2
fi

cat >"/tmp/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=Skate Streamer encoder (git pull then Node)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=$(id -gn "$SERVICE_USER")
WorkingDirectory=${ENCODER_DIR}
Environment=NODE_ENV=production
ExecStartPre=-/usr/bin/git -C ${REPO_ROOT} pull --ff-only
ExecStart=${NODE_BIN} ${NODE_ENVFILE_ARG}${ENCODER_DIR}/encoder.js
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
echo "Unit:   ${SERVICE_NAME}.service"
echo "Status: systemctl status ${SERVICE_NAME}.service"
echo "Logs:   journalctl -u ${SERVICE_NAME}.service -f"
echo "If you still have an old receiver unit on this Pi, disable it: sudo systemctl disable --now skate-streamer-receiver.service 2>/dev/null || true"
