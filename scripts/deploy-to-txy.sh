#!/usr/bin/env bash
# 小眠 AI · 部署 sleep-api（含管理端 API）到腾讯云
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TXY_HOST="${TXY_HOST:-106.53.168.166}"
TXY_USER="${TXY_USER:-ubuntu}"
TXY_PORT="${TXY_PORT:-22}"
REMOTE_DIR="/home/ubuntu/sleep-api"

echo "=========================================="
echo "  sleep-api · 部署到腾讯云"
echo "=========================================="

rsync -avz --delete \
  --exclude node_modules \
  --exclude data \
  --exclude .env \
  --exclude dist \
  --exclude .git \
  -e "ssh -o StrictHostKeyChecking=no -p ${TXY_PORT}" \
  "${ROOT}/" \
  "${TXY_USER}@${TXY_HOST}:${REMOTE_DIR}/"

ssh -o StrictHostKeyChecking=no -p "$TXY_PORT" "${TXY_USER}@${TXY_HOST}" bash -s <<'REMOTE'
set -euo pipefail
cd ~/sleep-api
docker-compose down --remove-orphans 2>/dev/null || true
docker rm -f sleep-api 2>/dev/null || true
docker-compose up --build -d
sleep 8
docker exec sleep-api node dist/db/migrate.js
curl -sf http://127.0.0.1:8787/health
echo ""
curl -sf -X POST http://127.0.0.1:8787/admin/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"admin123"}' | head -c 120
echo ""
REMOTE

echo ""
echo "✅ sleep-api 部署完成"
