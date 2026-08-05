# Running kanbanly OSS

**kanbanly — Kanban for ADHD.**

**Default posture is Docker.** You get the board UI, HTTP API, SSE, and a git-backed boards volume without installing Bun.

## Default: Docker Compose

```bash
git clone https://github.com/billiondollarsolo/kanbanly.git
cd kanbanly

docker compose -f deploy/compose.yaml up --build
```

Open **http://127.0.0.1:3847/**

| Step | What happens |
|------|----------------|
| 1 | Image build: install deps, build `apps/web`, copy demo fixtures |
| 2 | Entrypoint ensures `/boards` is a git repo (seed demo if empty) |
| 3 | `kanbanly serve` binds `0.0.0.0:3847` **inside** the container |
| 4 | Host maps **only** `127.0.0.1:3847` → container `3847` (no OSS auth) |

From a clone with Bun installed, the same Compose file is also:

```bash
bun start              # foreground
bun run start:detach   # background
bun run stop           # down
```

### Environment

| Env | Default (container) | Meaning |
|-----|---------------------|---------|
| `KANBANLY_HOST` | `0.0.0.0` | Bind address inside the container |
| `KANBANLY_PORT` | `3847` | Port inside the container |
| `KANBANLY_REPO` | `/boards` | Boards git path |
| `KANBANLY_DEMO_SRC` | `/opt/kanbanly/demo-boards` | Seed source when `/boards` is empty |

Host mapping is always `127.0.0.1:3847 → 3847` in `deploy/compose.yaml`. Do not change that unless you understand the [security note](#security).

### Commands

```bash
# Foreground (logs in the terminal)
docker compose -f deploy/compose.yaml up --build

# Detached
docker compose -f deploy/compose.yaml up --build -d

# Stop (keeps the boards volume)
docker compose -f deploy/compose.yaml down

# Stop and delete demo boards data
docker compose -f deploy/compose.yaml down -v
```

### Use your own boards path

```bash
docker compose -f deploy/compose.yaml build

docker run --rm -p 127.0.0.1:3847:3847 \
  -v "$PWD/my-boards:/boards" \
  -e KANBANLY_REPO=/boards \
  kanbanly:latest
```

Entrypoint behavior for `/boards` (or `$KANBANLY_REPO`):

| Mount state | Behavior |
|-------------|----------|
| Empty | Copy demo from `fixtures/boards-layout-a`, then `git init` + commit |
| Files but no `.git` | `git init` + initial commit |
| Already a git repo | Leave content alone; serve it |

### Health

```bash
curl -sf http://127.0.0.1:3847/health
# → {"ok":true, ...}
```

Docker `HEALTHCHECK` hits the same URL inside the container.

### Files

| Path | Role |
|------|------|
| `Dockerfile` | Single-stage Bun image; builds web UI; `ENTRYPOINT` serve |
| `deploy/compose.yaml` | Default service, loopback port, `boards-data` volume |
| `deploy/docker-entrypoint.sh` | Seed + git init + `serve` with env defaults |
| `.dockerignore` | Keeps image small (no `node_modules`, private SaaS tree, etc.) |

---

## Local Bun (development only)

Use this when changing TypeScript or the UI — **not** as the primary way to run OSS.

```bash
bun install
bun run build
./bin/kanbanly serve --repo /path/to/boards-git
# → http://127.0.0.1:3847/
```

`--repo` must be a **git** repository with layout A (multi-board subdirs) or B (board at root). See the main [README](../README.md#what-is-a-boards-repo).

Environment defaults for the CLI (same names as Docker):

- `KANBANLY_HOST` — default bind (fallback `127.0.0.1` outside Docker)
- `KANBANLY_PORT` — default port (`3847`)
- `KANBANLY_REPO` — default `--repo` path

---

## Security

OSS has **no authentication**. Anyone who can reach the bind address can push commits into every connected boards repo.

- Prefer the Compose default: host port on **loopback only**
- The CLI warns if you bind a non-loopback host
- Put any public exposure behind your own reverse proxy, TLS, and access control
