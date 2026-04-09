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
#   sudo ./install-systemd-skate-streamer.sh
#   # If node is only on your user PATH (nvm, fnm), the script resolves it via SUDO_USER.
#   # Override explicitly:
#   sudo SKATE_NODE_BIN=/home/you/.nvm/versions/node/v24.14.1/bin/node ./install-systemd-skate-streamer.sh
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RECEIVER_DIR="${SKATE_RECEIVER_DIR:-$REPO_ROOT/reciever}"
SERVICE_NAME="${SKATE_SYSTEMD_UNIT:-skate-streamer-receiver}"
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
    # NVM: login shells often skip .bashrc; source nvm.sh explicitly (non-interactive-safe).
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
    # NVM: latest installed version without invoking nvm.sh (same layout as `which node`).
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
