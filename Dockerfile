# kanbanly OSS — default run posture is Docker (UI + API + git boards).
#   docker compose -f deploy/compose.yaml up --build
#   → http://127.0.0.1:3847/

FROM oven/bun:1.2-alpine
WORKDIR /app

RUN apk add --no-cache git

# Full workspace sources before install (workspaces need real package trees)
COPY package.json bun.lock tsconfig.base.json ./
COPY packages/core packages/core
COPY packages/server packages/server
COPY apps/web apps/web
COPY fixtures/boards-layout-a /opt/kanbanly/demo-boards
COPY deploy/docker-entrypoint.sh /usr/local/bin/kanbanly-entrypoint

RUN chmod +x /usr/local/bin/kanbanly-entrypoint \
  && bun install \
  && bun run --filter @kanbanly/web build \
  && mkdir -p /boards

# Boards git data (compose mounts a named volume here)
VOLUME ["/boards"]

ENV KANBANLY_HOST=0.0.0.0 \
    KANBANLY_PORT=3847 \
    KANBANLY_REPO=/boards \
    KANBANLY_DEMO_SRC=/opt/kanbanly/demo-boards

EXPOSE 3847

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:'+(process.env.KANBANLY_PORT||3847)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["kanbanly-entrypoint"]
CMD ["serve"]
