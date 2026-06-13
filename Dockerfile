# sleep-api Dockerfile
# 多阶段构建，最终镜像只包含运行产物

# ---- 构建阶段 ----
FROM node:22-alpine AS builder

WORKDIR /app

# 先复制依赖文件，利用缓存层
COPY package*.json ./
RUN npm ci --only=production=false

# 复制源码并编译
COPY . .
RUN npm run build

# ---- 运行阶段 ----
FROM node:22-alpine AS runner

WORKDIR /app

# 只复制生产依赖和编译产物
COPY package*.json ./
RUN npm ci --only=production && npm cache clean --force

COPY --from=builder /app/dist ./dist

# 健康检查
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:8787/health', (r) => r.statusCode === 200 ? process.exit(0) : process.exit(1))"

EXPOSE 8787

CMD ["node", "dist/index.js"]
