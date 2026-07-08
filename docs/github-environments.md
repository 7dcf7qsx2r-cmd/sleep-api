# GitHub 双环境（UAT / Production）配置指南

## 架构

| 环境 | 分支 | 服务器 | 目录 |
|------|------|--------|------|
| **uat** | `develop` / `uat` | 106.53.168.166（ubuntu） | `/home/ubuntu/sleep-api` |
| **production** | `main` | 119.29.148.43（root） | `/root/sleep-api` |

生产 **DATABASE_URL** 指向腾讯云独立 PostgreSQL（非 CVM 本机）：

```
postgresql://admin:***@172.16.0.12:5432/sleep
```

详见本地机密文档 `docs/项目登录方式.md` §4。

推送代码后自动部署：

- 推 `develop` → UAT
- 推 `main` → 生产（可在 GitHub 给 production 环境加「需要审批」）

---

## 第一步：在 GitHub 创建 Environments

1. 打开 https://github.com/7dcf7qsx2r-cmd/sleep-api/settings/environments  
2. 点 **New environment**，名称填 **`uat`**，保存  
3. 再建一个 **`production`**（可选：勾选 **Required reviewers** 部署前人工批准）

---

## 第二步：上传 Secrets（推荐用脚本）

### 2.1 安装 GitHub CLI（本机一次）

```bash
brew install gh
gh auth login
```

### 2.2 准备本地 secrets 文件（已在仓库外、已 gitignore）

```bash
cd sleep-api
cp secrets/local/production.env.example secrets/local/production.env
cp secrets/local/uat.env.example secrets/local/uat.env
# 用编辑器填入真实值（可参考 docs/项目登录方式.md）
```

生产 SSH 私钥：

```bash
cp ~/.ssh/xiaomian-txy.pem secrets/local/production.ssh
chmod 600 secrets/local/production.ssh
```

UAT SSH 私钥（轻量服务器 ubuntu 用户对应的私钥）：

```bash
cp ~/.ssh/你的uat私钥 secrets/local/uat.ssh
chmod 600 secrets/local/uat.ssh
```

### 2.3 一键上传

```bash
chmod +x scripts/ci/upload-github-secrets.sh
./scripts/ci/upload-github-secrets.sh production secrets/local/production.env
./scripts/ci/upload-github-secrets.sh uat secrets/local/uat.env
```

---

## 第三步：Secrets 清单（每个 Environment 都要有）

| Secret | UAT | Production |
|--------|-----|--------------|
| `SERVER_SSH_KEY` | uat 服务器私钥 | `xiaomian-txy.pem` 内容 |
| `DATABASE_URL` | UAT 库连接串 | `postgresql://admin:***@172.16.0.12:5432/sleep` |
| `JWT_SECRET` | **独立** 随机长串 | **独立** 随机长串（勿与 UAT 相同） |
| `DEEPSEEK_API_KEY` | 可同生产或单独 | 生产 Key |
| `SILICONFLOW_API_KEY` | 同上 | 同上 |
| `WECHAT_APP_ID` / `WECHAT_APP_SECRET` | 按需 | 按需 |
| `TENCENT_SMS_*` | 按需 | 按需 |
| `RADAR_PUSH_SECRET` | 可选 | 可选 |

未填写的可选 Secret 可留空，脚本会跳过空行。

---

## 第四步：创建 develop 分支（UAT 用）

```bash
git checkout -b develop
git push -u github develop
```

之后日常开发合并到 `develop` 走 UAT；验证通过后合并 `main` 走生产。

---

## 第五步：手动触发部署

GitHub → **Actions** → 选 **Deploy UAT** 或 **Deploy Production** → **Run workflow**

---

## 不用脚本时（网页手工填 Secret）

Environment → **Add secret** → Name 填 `DATABASE_URL`，Value 粘贴连接串，逐个添加。

`SERVER_SSH_KEY`：打开私钥文件，**整文件复制**（含 `BEGIN/END` 行）粘贴。

---

## 相关文件

| 文件 | 说明 |
|------|------|
| `.github/workflows/deploy-uat.yml` | UAT 流水线 |
| `.github/workflows/deploy-production.yml` | 生产流水线 |
| `scripts/ci/render-dotenv.sh` | 由 Secrets 生成 `.env` |
| `scripts/ci/deploy-remote.sh` | 服务器上 docker compose 部署 |
| `secrets/local/*.env.example` | 本地 secrets 模板 |

---

## 常见问题

**Q: push main 没部署？**  
检查 production Environment 的 Secrets 是否齐全，Actions 页看失败日志。

**Q: UAT 和 PRD 能用同一个 JWT_SECRET 吗？**  
不能，否则 UAT 签发的 token 可能在生产可用。

**Q: 改环境变量后要做什么？**  
更新 GitHub Environment Secret → 重新 Run workflow 或 push 触发部署。
