# 语途服务器镜像。
#
# 在仓库根目录构建(要用到工作区里的 packages/core、packages/billing):
#   docker build -f services/api/Dockerfile -t yutu-api .
# 运行(环境变量见 docs/07-服务器部署.md):
#   docker run -d --env-file /etc/yutu/api.env -p 127.0.0.1:8080:8080 yutu-api
#
# 只用逐个目录 COPY,不整个仓库拷进去:本机的 node_modules、App 代码、.git、.env 都不会进镜像。
FROM node:22-bookworm-slim

# ffmpeg:AI 语音模块用来转换录音格式;tini:当 1 号进程,把停止信号转给 Node、回收僵尸进程
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg tini ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false

# 先只拷依赖清单并安装:改代码不用重装依赖(构建缓存)。
# 只装服务器这个工作区(和它用到的 core、billing)的生产依赖,不装 App(Expo)的依赖。
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/billing/package.json packages/billing/
COPY services/api/package.json services/api/
RUN npm ci --omit=dev --workspace=@lingo/api --include-workspace-root=false \
  && npm cache clean --force

COPY packages/core/src packages/core/src
COPY packages/billing/src packages/billing/src
COPY services/api/src services/api/src
COPY services/api/tsconfig.json services/api/
# 课程、语言包、口语场景(AI 老师按场景对话时要读)
COPY content content

# 没配 DATABASE_URL 时服务器退回到 PGlite(./data/pglite),只适合临时试跑:
# 数据在容器里,重新部署就没了。正式环境必须配 DATABASE_URL(RDS)。
RUN mkdir -p /app/services/api/data && chown node:node /app/services/api/data

# 不用 root 运行
USER node
WORKDIR /app/services/api
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/v1/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["npm", "start"]
