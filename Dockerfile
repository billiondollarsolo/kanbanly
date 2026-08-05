# kanbanly OSS — git-backed kanban board server
FROM oven/bun:1.2-alpine AS base
WORKDIR /app

# Install git (required for boards repos)
RUN apk add --no-cache git

# Workspace packages
COPY package.json bun.lock tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/server/package.json packages/server/
COPY apps/web/package.json apps/web/

RUN bun install --frozen-lockfile || bun install

COPY packages/core packages/core
COPY packages/server packages/server
COPY apps/web apps/web

# Build board UI into server public/
RUN bun run --filter @kanbanly/web build

ENV KANBANLY_HOST=0.0.0.0
ENV KANBANLY_PORT=3847
EXPOSE 3847

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:'+(process.env.KANBANLY_PORT||3847)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Default: serve UI; pass --repo at runtime or use Connect wizard
ENTRYPOINT ["bun", "run", "packages/server/src/cli.ts"]
CMD ["serve", "--host", "0.0.0.0", "--port", "3847"]
