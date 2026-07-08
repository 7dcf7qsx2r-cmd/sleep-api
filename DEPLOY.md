# 小眠 sleep-api 部署指南

## 架构说明

| 环境 | 服务器 | 数据库 |
|------|--------|--------|
| **UAT** | 106.53.168.166 | 独立库或隧道（见 GitHub `uat` Environment） |
| **Production** | 119.29.148.43 | **腾讯云独立 PostgreSQL** `172.16.0.12:5432/sleep`（与 CVM 同 VPC 内网，详见 `docs/项目登录方式.md`） |

生产环境 **不在 CVM 上安装 PostgreSQL**，应用容器通过内网连接云数据库。

---

## 方案一：GitHub Actions 双环境（推荐 · 2026-07）

### 1. 生产服务器首次初始化

```bash
ssh -i ~/.ssh/xiaomian-txy.pem root@119.29.148.43 'bash -s' < scripts/ci/bootstrap-prd-server.sh
```

业务库连接串（密码 `/` 须 URL 编码为 `%2F`）：

```
postgresql://admin:****@172.16.0.12:5432/sleep
```

### 2. GitHub Environments

详见 **[docs/github-environments.md](docs/github-environments.md)**：

- `uat` → 推 `develop` 分支自动部署
- `production` → 推 `main` 分支自动部署

每个 Environment 单独配置 `DATABASE_URL`、`JWT_SECRET`、`SERVER_SSH_KEY` 等 Secrets。

### 3. 本地一键上传 Secrets（需 `gh auth login`）

```bash
cp secrets/local/production.env.example secrets/local/production.env
# 填入独立库连接串与密钥
./scripts/ci/upload-github-secrets.sh production secrets/local/production.env
```

### 5. Nginx + HTTPS（api.xmianai.com）

生产 CVM 已安装 Nginx，443 反代至 `127.0.0.1:8787`，证书覆盖 `api.xmianai.com`（有效期至 2026-10-03）。

**切换 DNS（你需在域名控制台操作一次）：**

| 记录 | 类型 | 原值 | 新值 |
|------|------|------|------|
| `api` | A | 106.53.168.166 | **119.29.148.43** |

切换后验证：

```bash
curl -sI https://xmianai.com/ | head -1
curl -sI https://admin.xmianai.com/ | head -1
curl https://api.xmianai.com/health
```

**官网 / 管理后台迁移**（静态文件在 `/var/www/xiaomian`、`/var/www/xiaomian-admin`）：

| 主机记录 | 改为 |
|---------|------|
| `@` | 119.29.148.43 |
| `www` | 119.29.148.43 |
| `admin` | 119.29.148.43 |

脚本：`scripts/ci/setup-nginx-https.sh`（支持 `--ssl-from-uat` 从旧机复制证书）

---

## 方案二：Gitee 流水线 + SSH 直连（旧）

### 1. 服务器准备

确保服务器已安装 Docker：

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
```

### 2. Gitee 仓库配置

#### 2.1 创建 Gitee 仓库

在 Gitee 上创建仓库，将代码推送上去：

```bash
git init
git remote add origin https://gitee.com/YOUR_USERNAME/sleep-api.git
git add .
git commit -m "init"
git push -u origin master
```

#### 2.2 配置 CI/CD 变量

进入 Gitee 仓库 → **管理** → **CI/CD 变量**，添加以下变量：

| 变量名 | 说明 | 必填 |
|--------|------|------|
| `SERVER_HOST` | 服务器 IP 地址 | ✅ |
| `SERVER_USER` | SSH 登录用户名（如 `root`） | ✅ |
| `SERVER_SSH_KEY` | SSH 私钥（`~/.ssh/id_rsa` 内容） | ✅ |
| `DATABASE_URL` | PostgreSQL 连接串 | ✅ |
| `JWT_SECRET` | JWT 密钥（生产环境请用随机长字符串） | ✅ |
| `DEEPSEEK_API_KEY` | DeepSeek API Key | ✅ |
| `SENTRY_DSN` | Sentry 错误追踪（可选） | ❌ |

> **注意**：`SERVER_SSH_KEY` 需要是免密登录服务器的私钥。在服务器上执行 `cat ~/.ssh/id_rsa` 获取。

#### 2.3 启用 Gitee CI

进入仓库 → **管理** → **功能设置** → 开启 **CI/CD**。

### 3. 部署流程

每次推送代码到 `master` 或 `main` 分支，Gitee 会自动：

1. **构建阶段**：在 Gitee 提供的 Docker 环境中构建镜像
2. **部署阶段**：SSH 登录你的服务器，拉取镜像并运行容器
3. **健康检查**：访问 `http://localhost:8787/health` 确认服务正常
4. **失败回滚**：健康检查失败时自动回滚到旧版本

### 4. 手动触发部署

```bash
git push origin master
```

然后在 Gitee 仓库 → **CI/CD** → **流水线** 中查看构建进度。

---

## 方案二：镜像仓库 + 服务器自动拉取

如果你不想把服务器 SSH 密钥交给 Gitee，可以用这个方案：

### 1. 推送镜像到阿里云 ACR

在 `.gitee-ci.yml` 中修改镜像前缀为阿里云 ACR：

```yaml
variables:
  DOCKER_IMAGE: registry.cn-shenzhen.aliyuncs.com/YOUR_NAMESPACE/sleep-api:$CI_COMMIT_SHA
```

在 Gitee CI/CD 变量中添加：
- `ALIYUN_REGISTRY_USER`
- `ALIYUN_REGISTRY_PASSWORD`

### 2. 服务器端配置 Watchtower

在服务器上运行 Watchtower，自动检测镜像更新并重启容器：

```bash
docker run -d \
  --name watchtower \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -e REPO_USER=YOUR_ALIYUN_USER \
  -e REPO_PASS=YOUR_ALIYUN_PASS \
  containrrr/watchtower sleep-api \
  --interval 60
```

---

## 环境变量说明

| 变量名 | 开发默认值 | 生产建议 |
|--------|-----------|---------|
| `DATABASE_URL` | `postgres://sleep:sleep@localhost:5432/sleep_api` | 使用独立数据库实例 |
| `JWT_SECRET` | `change-me-in-production...` | 64位以上随机字符串 |
| `JWT_EXPIRES_IN` | `30d` | 按需调整 |
| `DEEPSEEK_API_KEY` | - | 从 DeepSeek 控制台获取 |
| `SENTRY_DSN` | - | 从 Sentry 获取 |

---

## 常见问题

### Q: 服务器上用什么数据库？
**A**: 生产环境建议用云数据库（如阿里云 RDS PostgreSQL），或自己在服务器上运行 PostgreSQL 容器。

### Q: 如何更新环境变量？
**A**: 修改 Gitee CI/CD 变量后，重新触发一次流水线即可。

### Q: 如何查看日志？
**A**: 服务器上执行 `docker logs -f sleep-api`。

### Q: 如何回滚？
**A**: 流水线已内置自动回滚。如需手动回滚：
```bash
docker stop sleep-api
docker rename sleep-api-backup sleep-api
docker start sleep-api
```
