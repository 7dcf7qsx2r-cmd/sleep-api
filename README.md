# sleep-api

小眠 AI 后端 · P0：认证 + AI BFF + 日配额。

## 快速开始

### 方式 A：Docker（推荐生产对齐）

本机先装 Docker（macOS 可在终端运行 `bash scripts/install-docker-macos.sh`）。

```bash
cd sleep-api
cp .env.example .env
# 编辑 .env，填入 DEEPSEEK_API_KEY

docker compose up -d
npm install
npm run db:setup
npm run dev
```

### 方式 B：无 Docker · PGlite（仅本地开发）

```bash
cd sleep-api
cp .env.example .env
echo 'USE_PGLITE=1' >> .env

npm install
npm run db:setup:pglite
npm run dev:pglite
```

### 一键 Docker 开发（推荐）

```bash
# macOS 若 docker 命令找不到，脚本会自动补 PATH
npm run dev:docker   # compose up + db:setup
npm run dev          # 启动 API
```

### 联调验收

```bash
npm run smoke          # P0 冒烟
npm run integration    # P0+P1 全流程（guest→同步→登录→merge→bootstrap）
```

API 默认：`http://localhost:8787` · 健康检查应显示 `dbBackend: "postgres"`

### App 端联调

在 `sleep-app-rn/.env` 配置 `EXPO_PUBLIC_API_URL=http://localhost:8787`，重启 Expo 后：

1. 打开 **设置 → 账号与同步 → 登录**（`demo` / `demo123`）
2. 记梦 / 聊天后数据会自动上传（约 1.5s 防抖）
3. 重装或清数据后重新登录，应能拉回云端数据

## 预制测试账号

| 用户名 | 密码 |
|--------|------|
| `demo` | `demo123` |
| `xiaomian` | `xiaomian2026` |

## 主要接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/health` | 健康检查 |
| POST | `/auth/guest` | 匿名会话 |
| POST | `/auth/login` | 用户名密码登录 |
| GET | `/ai/quota` | 今日配额 |
| POST | `/ai/chat` | 小眠聊天 |
| POST | `/ai/dream/interpret` | 结构化解梦 |

完整 OpenAPI：`docs/openapi.yaml`

## 客户端配置

在 `sleep-app-rn` 根目录 `.env`：

```env
EXPO_PUBLIC_API_URL=http://localhost:8787
```

然后重启 Expo：`npm start`

## 环境变量

见 `.env.example`。

## P1 · 数据同步（已实现）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/sync/bootstrap` | 拉取全量域快照 |
| GET | `/sync/delta?since=` | 增量（按 `updated_at`） |
| PUT | `/sync/:domain` | 上传域数据（带 `version`，冲突 409） |
| POST | `/auth/merge-guest` | 登录后合并匿名数据 |
| GET | `/energy/account` | 能量账户（仅 user） |

同步域：`profile` `persona` `dream_diary` `dream_bottles` `interpret` `standin` `bedtime_story` `chat_messages` `voice_prefs`

## 进度

- [x] P0：Auth + AI BFF + 配额
- [x] P1：JSON 域同步 + version 冲突 + merge-guest + 能量账户读
- [x] P2：能量 earn/spend/任务 + 商店能量/沙箱支付
- [x] P3：社交 + 推送
  - [x] 好友关系（申请/接受/列表）
  - [x] 梦境瓶（匿名漂流瓶 + 好友定向投递 + 回信）
  - [x] Feed 动态流（发布/分页浏览/点赞）
  - [x] 推送通知（FCM 设备注册 + 推送队列 + Worker 消费）
  - [x] 轻量任务队列（数据库实现，无 Redis 依赖）

## P3 API

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/social/friends/request` | 申请好友 |
| POST | `/social/friends/accept` | 接受好友 |
| POST | `/social/friends/remove` | 删除好友 |
| GET | `/social/friends` | 好友列表 |
| GET | `/social/friends/pending` | 待处理申请 |
| POST | `/social/bottles` | 投递梦境瓶 |
| GET | `/social/bottles/random` | 随机收取瓶 |
| POST | `/social/bottles/:id/reply` | 回信 |
| GET | `/social/bottles/:id/replies` | 查看回信 |
| GET | `/social/bottles/sent` | 我投递的瓶 |
| GET | `/social/bottles/received` | 我收取的瓶 |
| POST | `/social/feed` | 发布动态 |
| GET | `/social/feed?cursor=&limit=` | 浏览动态 |
| POST | `/social/feed/:id/like` | 点赞/取消 |
| POST | `/push/register` | 注册推送设备 |
| POST | `/push/unregister` | 注销推送设备 |
