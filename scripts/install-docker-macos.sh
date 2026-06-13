#!/usr/bin/env bash
# 在 macOS 本机终端运行（需管理员密码）
set -euo pipefail

echo "==> 安装 Homebrew（若尚未安装）"
if ! command -v brew >/dev/null 2>&1; then
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  if [[ -x /opt/homebrew/bin/brew ]]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
  fi
fi

echo "==> 安装 Colima + Docker CLI（轻量，无需 Docker Desktop）"
brew install colima docker docker-compose

echo "==> 启动 Colima VM"
colima start --cpu 2 --memory 4 --disk 20

echo "==> 验证"
docker version
docker compose version

echo ""
echo "完成。回到 sleep-api 目录执行："
echo "  docker compose up -d"
echo "  npm run db:setup"
echo "  npm run dev"
