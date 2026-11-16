#!/usr/bin/env bash
#
# uninstall.sh — remove the systemd unit and app dir.
set -euo pipefail

SERVICE_NAME="xingchiapi-free-bridge"
RUN_USER="${SUDO_USER:-root}"
RUN_HOME="$(getent passwd "$RUN_USER" | cut -d: -f6)"
APP_DIR="${APP_DIR:-$RUN_HOME/xingchiapi-free-bridge}"

[[ $EUID -eq 0 ]] || { echo "error: run as root (sudo)" >&2; exit 1; }

systemctl disable --now "$SERVICE_NAME" 2>/dev/null || true
rm -f "/etc/systemd/system/${SERVICE_NAME}.service"
systemctl daemon-reload

if [[ "${KEEP_DATA:-0}" == "1" ]]; then
  echo "kept $APP_DIR (KEEP_DATA=1)"
else
  rm -rf "$APP_DIR"
  echo "removed $APP_DIR"
fi

echo "==> uninstalled $SERVICE_NAME"
