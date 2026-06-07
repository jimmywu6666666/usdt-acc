#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
CONFIG_FILE="$ROOT_DIR/.env.remote"

if [[ ! -f "$CONFIG_FILE" ]]; then
  echo "缺少 $CONFIG_FILE"
  exit 1
fi

set -a
source "$CONFIG_FILE"
set +a

KEY_PATH="${SSH_KEY/#\~/$HOME}"
echo "数据库隧道：http://127.0.0.1:${TUNNEL_LOCAL_PORT} -> ${SSH_HOST}:5432"
exec ssh \
  -i "$KEY_PATH" \
  -p "${SSH_PORT:-22}" \
  -N \
  -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 \
  -L "${TUNNEL_LOCAL_PORT}:127.0.0.1:5432" \
  "${SSH_USER}@${SSH_HOST}"
