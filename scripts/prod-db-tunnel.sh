#!/usr/bin/env bash
# 将生产 PostgreSQL 映射到本机 15432（需 SSH 免密登录 106.53.168.166）
set -euo pipefail

HOST="${PROD_SSH_HOST:-106.53.168.166}"
USER="${PROD_SSH_USER:-ubuntu}"
LOCAL_PORT="${PROD_DB_LOCAL_PORT:-15432}"
REMOTE_PORT="${PROD_DB_REMOTE_PORT:-5432}"

if lsof -iTCP:"$LOCAL_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "✅ 隧道已在运行: 127.0.0.1:${LOCAL_PORT} → ${USER}@${HOST}:${REMOTE_PORT}"
  exit 0
fi

echo "🔗 启动 SSH 隧道: 127.0.0.1:${LOCAL_PORT} → ${HOST}:${REMOTE_PORT}"
exec ssh -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
  -N -L "${LOCAL_PORT}:127.0.0.1:${REMOTE_PORT}" "${USER}@${HOST}"
