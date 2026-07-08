#!/usr/bin/env bash
# 将本地 secrets 文件上传到 GitHub Environment（需 gh login + repo 权限）
# 用法:
#   ./scripts/ci/upload-github-secrets.sh uat      secrets/local/uat.env
#   ./scripts/ci/upload-github-secrets.sh production secrets/local/production.env
set -euo pipefail

ENV_NAME="${1:?usage: upload-github-secrets.sh <uat|production> <env-file>}"
ENV_FILE="${2:?usage: upload-github-secrets.sh <uat|production> <env-file>}"
REPO="${GITHUB_REPO_SLUG:-7dcf7qsx2r-cmd/sleep-api}"

if ! command -v gh >/dev/null 2>&1; then
  echo "请先安装 GitHub CLI: brew install gh && gh auth login" >&2
  exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "文件不存在: $ENV_FILE" >&2
  exit 1
fi

echo "上传到 GitHub Environment: $ENV_NAME ($REPO)"
while IFS= read -r line || [[ -n "$line" ]]; do
  line="${line%%#*}"
  line="$(echo "$line" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
  [[ -z "$line" ]] && continue
  key="${line%%=*}"
  val="${line#*=}"
  [[ -z "$key" ]] && continue
  echo "  secret: $key"
  gh secret set "$key" --env "$ENV_NAME" --repo "$REPO" --body "$val"
done < "$ENV_FILE"

if [[ -f "secrets/local/${ENV_NAME}.ssh" ]]; then
  echo "  secret: SERVER_SSH_KEY (from secrets/local/${ENV_NAME}.ssh)"
  gh secret set SERVER_SSH_KEY --env "$ENV_NAME" --repo "$REPO" < "secrets/local/${ENV_NAME}.ssh"
fi

echo "完成。可在 GitHub → Settings → Environments → $ENV_NAME 查看。"
