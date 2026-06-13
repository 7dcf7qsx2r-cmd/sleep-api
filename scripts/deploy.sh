#!/bin/bash
# sleep-api 部署脚本（服务器端执行）
# 用法：./scripts/deploy.sh [镜像标签]

set -e

IMAGE_TAG=${1:-latest}
IMAGE_NAME="${DOCKER_IMAGE_PREFIX:-registry.cn-shenzhen.aliyuncs.com/xiaomian}/sleep-api:${IMAGE_TAG}"
CONTAINER_NAME="sleep-api"
HEALTH_URL="http://localhost:8787/health"

echo "[deploy] 拉取镜像: ${IMAGE_NAME}"
docker pull "${IMAGE_NAME}"

echo "[deploy] 备份当前容器"
docker stop "${CONTAINER_NAME}-backup" 2>/dev/null || true
docker rename "${CONTAINER_NAME}" "${CONTAINER_NAME}-backup" 2>/dev/null || true

echo "[deploy] 启动新容器"
docker run -d \
  --name "${CONTAINER_NAME}" \
  --restart unless-stopped \
  -p 8787:8787 \
  -e NODE_ENV=production \
  -e PORT=8787 \
  -e DATABASE_URL="${DATABASE_URL}" \
  -e JWT_SECRET="${JWT_SECRET}" \
  -e JWT_EXPIRES_IN="${JWT_EXPIRES_IN:-30d}" \
  -e DEEPSEEK_API_KEY="${DEEPSEEK_API_KEY}" \
  -e DEEPSEEK_API_URL="${DEEPSEEK_API_URL:-https://api.deepseek.com/v1/chat/completions}" \
  -e DEEPSEEK_MODEL="${DEEPSEEK_MODEL:-deepseek-chat}" \
  -e SENTRY_DSN="${SENTRY_DSN}" \
  -e QUOTA_GUEST_CHAT="${QUOTA_GUEST_CHAT:-15}" \
  -e QUOTA_GUEST_INTERPRET="${QUOTA_GUEST_INTERPRET:-2}" \
  -e QUOTA_USER_CHAT="${QUOTA_USER_CHAT:-80}" \
  -e QUOTA_USER_INTERPRET="${QUOTA_USER_INTERPRET:-10}" \
  "${IMAGE_NAME}"

echo "[deploy] 健康检查..."
sleep 5
for i in 1 2 3; do
  if curl -sf "${HEALTH_URL}" > /dev/null; then
    echo "[deploy] 健康检查通过 ✅"
    docker rm -f "${CONTAINER_NAME}-backup" 2>/dev/null || true
    echo "[deploy] 部署完成"
    exit 0
  fi
  echo "[deploy] 健康检查重试 ($i/3)..."
  sleep 3
done

echo "[deploy] 健康检查失败，回滚..."
docker stop "${CONTAINER_NAME}" 2>/dev/null || true
docker rename "${CONTAINER_NAME}-backup" "${CONTAINER_NAME}" 2>/dev/null || true
docker start "${CONTAINER_NAME}" 2>/dev/null || true
echo "[deploy] 已回滚到旧版本"
exit 1
