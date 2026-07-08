#!/usr/bin/env bash
# 生产 CVM 首次初始化（AlmaLinux 10 · 独立云数据库，不在本机装 PostgreSQL）
# 用法: ssh root@119.29.148.43 'bash -s' < scripts/ci/bootstrap-prd-server.sh
set -euo pipefail

echo "==> 安装 Podman + compose（AlmaLinux 10 无官方 Docker CE）"
dnf install -y podman-docker podman-compose postgresql

echo "==> 配置腾讯云 Docker Hub 镜像加速"
mkdir -p /etc/containers/registries.conf.d
cat > /etc/containers/registries.conf.d/000-mirror.conf << 'EOF'
[[registry]]
location = "docker.io"
[[registry.mirror]]
location = "mirror.ccs.tencentyun.com"
insecure = false
EOF

echo "==> 预拉 node 基础镜像"
podman pull node:22-alpine

mkdir -p /root/sleep-api
echo "bootstrap ok — 数据库请使用独立实例内网 172.16.0.12:5432/sleep"
