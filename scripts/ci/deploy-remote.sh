#!/usr/bin/env bash
# 在目标服务器上执行：docker compose 构建、启动、迁移、健康检查
set -euo pipefail

REMOTE_DIR="${REMOTE_DIR:?REMOTE_DIR required}"
ENV_FILE="${ENV_FILE:-.env}"

cd "$REMOTE_DIR"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "missing $ENV_FILE in $REMOTE_DIR" >&2
  exit 1
fi

if docker compose version >/dev/null 2>&1; then
  COMPOSE="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE="docker-compose"
elif command -v podman-compose >/dev/null 2>&1; then
  COMPOSE="podman-compose"
else
  echo "docker compose / podman-compose not found" >&2
  exit 1
fi

$COMPOSE down || true
$COMPOSE up --build -d

sleep 8
if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx sleep-api; then
  EXEC="docker exec sleep-api"
elif podman ps --format '{{.Names}}' 2>/dev/null | grep -qx sleep-api; then
  EXEC="podman exec sleep-api"
else
  echo "sleep-api container not running" >&2
  $COMPOSE ps || true
  exit 1
fi

$EXEC node dist/db/migrate.js

sleep 5
curl -sf "http://127.0.0.1:${PORT:-8787}/health" >/dev/null
echo "deploy ok"
