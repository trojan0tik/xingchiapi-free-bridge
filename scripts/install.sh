#!/usr/bin/env bash
#
# install.sh — deploy xingchiapi-free-bridge as a systemd service.
#
# Usage:
#   sudo ./scripts/install.sh                       # defaults: user $SUDO_USER, port 8792
#   sudo PORT=8793 ./scripts/install.sh             # custom port
#   sudo UA='opencode/0.15.0' ./scripts/install.sh   # custom injected identity
#
# The script is idempotent: re-running it updates the unit and restarts the
# service without touching the app directory.
set -euo pipefail

PORT="${PORT:-8792}"
BIND_HOST="${BIND_HOST:-127.0.0.1}"
UPSTREAM="${UPSTREAM:-https://api.xingchiapi.com}"
UA="${UA:-claude-cli/2.1.92 (external, sdk-cli)}"
XAPP="${XAPP:-cli}"
SERVICE_NAME="xingchiapi-free-bridge"

# install owner: the invoking user (not root), falling back to root
RUN_USER="${SUDO_USER:-root}"
RUN_HOME="$(getent passwd "$RUN_USER" | cut -d: -f6)"
APP_DIR="${APP_DIR:-$RUN_HOME/xingchiapi-free-bridge}"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN="$(command -v node || true)"

die() { echo "error: $*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "run as root (sudo)"
[[ -n "$NODE_BIN" ]] || die "node not found in PATH"
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)' \
  || die "node >= 18 required (found $($NODE_BIN -v))"
[[ "$BIND_HOST" == "127.0.0.1" || "$BIND_HOST" == "::1" || "$BIND_HOST" == "localhost" ]] \
  || echo "warning: binding to $BIND_HOST exposes the injector beyond loopback"

echo "==> app dir   : $APP_DIR (owner $RUN_USER)"
echo "==> upstream  : $UPSTREAM"
echo "==> listen    : http://$BIND_HOST:$PORT"
echo "==> identity  : ua='$UA' x-app='$XAPP'"

install -d -o "$RUN_USER" -g "$(id -gn "$RUN_USER")" "$APP_DIR"
install -m 0644 -o "$RUN_USER" -g "$(id -gn "$RUN_USER")" "$SRC_DIR/proxy.js" "$APP_DIR/proxy.js"
install -m 0644 -o "$RUN_USER" -g "$(id -gn "$RUN_USER")" "$SRC_DIR/package.json" "$APP_DIR/package.json"

if [[ ! -f "$APP_DIR/config.json" ]]; then
  install -m 0644 -o "$RUN_USER" -g "$(id -gn "$RUN_USER")" "$SRC_DIR/config.example.json" "$APP_DIR/config.json"
  echo "==> wrote default $APP_DIR/config.json"
fi

UNIT_PATH="/etc/systemd/system/${SERVICE_NAME}.service"
cat >"$UNIT_PATH" <<EOF
[Unit]
Description=${SERVICE_NAME} — header injector for client-gated LLM upstreams
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${RUN_USER}
Group=$(id -gn "$RUN_USER")
WorkingDirectory=${APP_DIR}
Environment=PORT=${PORT}
Environment=BIND_HOST=${BIND_HOST}
Environment=UPSTREAM=${UPSTREAM}
Environment="UA=${UA}"
Environment="XAPP=${XAPP}"
Environment=LOG_REQUESTS=1
Environment=NODE_ENV=production
ExecStart=${NODE_BIN} ${APP_DIR}/proxy.js
Restart=always
RestartSec=3
StandardOutput=append:${APP_DIR}/bridge.log
StandardError=append:${APP_DIR}/bridge.log
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

echo "==> wrote $UNIT_PATH"
systemctl daemon-reload
systemctl enable --now "$SERVICE_NAME"
sleep 2

if systemctl is-active --quiet "$SERVICE_NAME"; then
  echo "==> service active"
else
  echo "error: service failed to start" >&2
  journalctl -u "$SERVICE_NAME" -n 20 --no-pager >&2
  exit 1
fi

# the port must actually be listening before we call it done
if command -v ss >/dev/null 2>&1; then
  ss -ltn | grep -q ":$PORT\b" || die "nothing listening on $PORT"
fi

echo
echo "==> health check"
curl -s --max-time 10 "http://$BIND_HOST:$PORT/__health" || true
echo
echo "==> done. Point your router's base URL at: http://$BIND_HOST:$PORT"
echo "    (paths forwarded unchanged: /chat/completions, /models, ...)"
