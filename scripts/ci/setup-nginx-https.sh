#!/usr/bin/env bash
# 生产 CVM 安装 Nginx 并配置 api.xmianai.com 反代 + HTTPS
# 前置: DNS A 记录 api.xmianai.com → 119.29.148.43（切换前可先复制旧机证书）
# 用法:
#   ssh root@119.29.148.43 'bash -s' < scripts/ci/setup-nginx-https.sh
#   ssh root@119.29.148.43 'bash -s' < scripts/ci/setup-nginx-https.sh --cert-only
#   ssh root@119.29.148.43 'bash -s' < scripts/ci/setup-nginx-https.sh --ssl-from-uat
set -euo pipefail

DOMAIN="${DOMAIN:-api.xmianai.com}"
EMAIL="${CERTBOT_EMAIL:-admin@xmianai.com}"
UAT_HOST="${UAT_HOST:-ubuntu@106.53.168.166}"
CERT_ONLY=false
SSL_FROM_UAT=false
for arg in "$@"; do
  case "$arg" in
    --cert-only) CERT_ONLY=true ;;
    --ssl-from-uat) SSL_FROM_UAT=true ;;
  esac
done

write_nginx_http() {
  cat > "/etc/nginx/conf.d/${DOMAIN}.conf" << 'NGINX_EOF'
upstream sleep_api {
    server 127.0.0.1:8787;
    keepalive 32;
}

server {
    listen 80;
    listen [::]:80;
    server_name api.xmianai.com;

    client_max_body_size 20m;

    location / {
        proxy_pass http://sleep_api;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Connection "";
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
}
NGINX_EOF
}

write_nginx_ssl() {
  cat > "/etc/nginx/conf.d/${DOMAIN}.conf" << 'NGINX_EOF'
upstream sleep_api {
    server 127.0.0.1:8787;
    keepalive 32;
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name api.xmianai.com;

    ssl_certificate /etc/letsencrypt/live/xmianai.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/xmianai.com/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    client_max_body_size 20m;

    location / {
        proxy_pass http://sleep_api;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Connection "";
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
}

server {
    listen 80;
    listen [::]:80;
    server_name api.xmianai.com;
    return 301 https://$host$request_uri;
}
NGINX_EOF
}

if [[ "$SSL_FROM_UAT" == true ]]; then
  echo "==> 从旧 UAT 复制 Let's Encrypt 证书"
  ssh -o StrictHostKeyChecking=no "$UAT_HOST" 'sudo tar czf - -C /etc letsencrypt' | tar xzf - -C /etc
  dnf install -y nginx
  systemctl enable --now nginx
  write_nginx_ssl
  nginx -t && systemctl reload nginx
  systemctl enable --now certbot-renew.timer 2>/dev/null || true
  echo "HTTPS 已配置（证书来自 UAT，DNS 切换后即可对外生效）"
  exit 0
fi

if [[ "$CERT_ONLY" != true ]]; then
  echo "==> 安装 Nginx + Certbot"
  dnf install -y nginx certbot python3-certbot-nginx
  systemctl enable --now nginx
  write_nginx_http
  nginx -t && systemctl reload nginx
  echo "HTTP 反代已就绪: http://${DOMAIN}/health"
fi

echo "==> 检查 DNS"
RESOLVED=$(getent hosts "$DOMAIN" | awk '{print $1}' | head -1 || true)
EXPECTED=$(curl -s --max-time 3 ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')
if [[ -z "$RESOLVED" ]]; then
  echo "警告: 无法解析 ${DOMAIN}，请先在域名控制台添加 A 记录 → ${EXPECTED}" >&2
  exit 1
fi
if [[ "$RESOLVED" != "$EXPECTED" ]]; then
  echo "警告: ${DOMAIN} 当前解析到 ${RESOLVED}，本机公网 IP 为 ${EXPECTED}" >&2
  echo "请把 DNS A 记录改为 ${EXPECTED}，或执行 --ssl-from-uat 先复制旧机证书" >&2
  exit 2
fi

echo "==> 申请 Let's Encrypt 证书"
certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL" --redirect
systemctl reload nginx
systemctl enable --now certbot-renew.timer
echo "HTTPS 就绪: https://${DOMAIN}/health"
