#!/usr/bin/env bash
# 本机 Docker 开发启动（自动补 PATH）
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="/Applications/Docker.app/Contents/Resources/bin:${PATH}"

cd "$ROOT"

if ! docker info >/dev/null 2>&1; then
  echo "Docker 未运行，正在启动 Docker Desktop..."
  open -a Docker
  for i in $(seq 1 60); do
    docker info >/dev/null 2>&1 && break
    sleep 2
  done
fi

docker compose up -d
echo "等待 Postgres..."
for i in $(seq 1 30); do
  docker compose exec -T postgres pg_isready -U sleep -d sleep_api >/dev/null 2>&1 && break
  sleep 1
done

npm run db:setup
echo ""
echo "API: npm run dev"
echo "联调: npm run integration"
