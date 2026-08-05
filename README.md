# kanbanly

**Kanban for ADHD.**

Self-hosted kanban built for focus and agents. Boards are ordinary **git repositories** of markdown cards. Humans use the web UI; coding agents read and write the same files. Git is the only contract.

```text
UI  ──┐
      ├──▶  boards git remote  ◀──  agents (Claude, Cursor, …)
API ──┘
```

| | |
|---|---|
| **License** | [AGPL-3.0-or-later](LICENSE) |
| **Default run** | **Docker** (UI + API + demo boards) |
| **Open** | http://127.0.0.1:3847/ |
| **SaaS** | Private product: [kanbanly-saas](https://github.com/billiondollarsolo/kanbanly-saas) |

---

## Quick start (Docker — default)

You only need [Docker](https://docs.docker.com/get-docker/) with Compose v2.

```bash
git clone https://github.com/billiondollarsolo/kanbanly.git
cd kanbanly

docker compose -f deploy/compose.yaml up --build
```

Then open **http://127.0.0.1:3847/**

That one command:

1. Builds the React board UI into the image
2. Starts the HTTP API, SSE live updates, and git push queue
3. Seeds a **demo boards git repo** (layout A: `backend` + `web`) into a Docker volume on first start
4. Publishes the port on **loopback only** (`127.0.0.1:3847`) — OSS has **no login**

| Command | What it does |
|---------|----------------|
| `docker compose -f deploy/compose.yaml up --build` | Build + run in the foreground |
| `docker compose -f deploy/compose.yaml up --build -d` | Same, detached |
| `docker compose -f deploy/compose.yaml down` | Stop |
| `docker compose -f deploy/compose.yaml down -v` | Stop **and** wipe demo boards data |

If you already have [Bun](https://bun.sh) after cloning, these are shortcuts for the same Compose file:

```bash
bun start          # docker compose … up --build
bun run start:detach
bun run stop
```

Full runbook (env vars, volumes, health): **[docs/OSS.md](docs/OSS.md)**.  
How to test (offline → PAT remote → agent skill): **[docs/TESTING.md](docs/TESTING.md)**.  
Agent skill (installable): **[skills/kanbanly/SKILL.md](skills/kanbanly/SKILL.md)** (`bun run skill:install`).

### Use your own boards directory

Build once, then bind-mount any host path at `/boards`:

```bash
docker compose -f deploy/compose.yaml build

docker run --rm -p 127.0.0.1:3847:3847 \
  -v "$PWD/my-boards:/boards" \
  -e KANBANLY_REPO=/boards \
  kanbanly:latest
```

- Empty directory → entrypoint seeds the demo layout and `git init`
- Non-empty without `.git` → `git init` + initial commit
- Existing git boards repo (layout A or B) → used as-is

### Health check

```bash
curl -sf http://127.0.0.1:3847/health
```

Expect `"ok":true`. The image also defines a Docker `HEALTHCHECK` on the same endpoint.

---

## What is a “boards repo”?

A git repository using **layout A** (multiple boards as subdirectories) or **layout B** (one board at the repo root):

```text
boards/                    # git root (layout A)
  AGENTS.md                # conventions for agents
  backend/
    board.yml              # columns, labels
    cards/
      c-a1b2-setup-auth.md
  web/
    board.yml
    cards/
```

Each card is markdown: YAML frontmatter + `## Status` + `## Log` (see [Card format](#card-format)).

Demo fixtures live in `fixtures/boards-layout-a` and are copied into the container volume on first boot.

---

## Everyday UI

| Action | How |
|--------|-----|
| Move a card | Drag between / within columns |
| Add a card | Bottom of each column, or header quick-add |
| Add a list | **+ Add a list** at the end of the board (writes `board.yml`) |
| Rename / reorder / delete list | Column **···** menu (double-click title to rename) |
| New board | Toolbar **+ Board** (layout A subdirectory) |
| Edit | Click card → detail panel → Save |
| Sync from remote | **Fetch remote** (when `origin` is configured) |
| Conflicts | Banner → keep-mine / keep-theirs |
| Theme | Light / Dark / System (header) |
| Help | Press `?` |

**Deep links:** `/b/<board>` · `/b/<board>/<cardId>` · `/r/<remote-slug>/b/<board>`

**Keyboard:** arrows / hjkl focus · Shift+←/→ move · Enter open · `x` multi-select · Esc close · `?` help

---

## Security

OSS has **no authentication**. Anyone who can reach the bind address can change every connected boards repo.

- Default Compose publishes **only** `127.0.0.1:3847`
- Binding off loopback (or publishing `0.0.0.0` on the host) prints a CLI warning — do that only behind your own reverse proxy / network controls

---

## Repository layout

| Path | Role |
|------|------|
| `packages/core` | Card format, merge/heal, Git + S3 adapters (AGPL boundary) |
| `packages/server` | OSS HTTP server, SSE, push queue, multi-remote registry |
| `apps/web` | Board UI (built into the Docker image) |
| `apps/start` | Optional TanStack Start stack (local dev only) |
| `fixtures/` | Demo boards layout |
| `deploy/` | `compose.yaml` + container entrypoint |
| `docs/OSS.md` | **How to run OSS** (Docker default) |
| `bin/kanbanly` | CLI when not using Docker |

---

## Develop without Docker (optional)

Prefer Docker for **running** the product. Use Bun only when changing TypeScript or the UI.

```bash
bun install
bun run build                 # UI → packages/server/public
bun test                      # core + server
bun run typecheck && bun run lint

# Serve a git-initialized boards path
./bin/kanbanly serve --repo /path/to/boards-git
# → http://127.0.0.1:3847/
```

Scaffold a boards path:

```bash
./bin/kanbanly setup --code /tmp/code --boards /tmp/boards \
  --remote git@github.com:you/boards.git --board backend
cd /tmp/boards && git init && git add -A && git commit -m init
./bin/kanbanly serve --repo /tmp/boards
```

### CLI

```text
kanbanly serve [--host] [--port] [--repo]
kanbanly merge-driver <ancestor> <ours> <theirs>
kanbanly setup --code <path> --boards <path> --remote <url> [--board backend]
kanbanly skill-install [--path <dir>]
```

Environment (also used in Docker): `KANBANLY_HOST`, `KANBANLY_PORT`, `KANBANLY_REPO`.

### Optional: TanStack Start

```bash
KANBANLY_REPO=$PWD/fixtures/boards-layout-a bun run dev:start
# http://127.0.0.1:3000/
```

---

## HTTP API (summary)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/health` | Liveness, sync, credentials status |
| GET/POST | `/api/connect` | Connect local path or clone URL |
| GET | `/api/remotes` | Multi-remote list |
| GET | `/api/boards` · `/api/boards/:id` | List / load board |
| POST | `/api/boards` | Create board (layout A dir + starter `board.yml`) |
| POST | `/api/boards/:id/columns` | Add list |
| PUT | `/api/boards/:id/columns` | Reorder lists `{ order: string[] }` |
| PATCH | `/api/boards/:id/columns/:col` | Rename list `{ name }` |
| DELETE | `/api/boards/:id/columns/:col` | Delete list (`moveTo` if cards) |
| POST | `/api/boards/:id/cards` | Create card |
| POST | `.../cards/:cid/move` | Move card |
| PATCH | `.../cards/:cid` | Update card |
| GET | `.../cards/:cid/history` | `git log --follow` |
| POST | `/api/boards/:id/archive` | Archive cards |
| GET | `/api/events` | SSE board updates |
| GET | `/api/sync` | Push queue status |
| POST | `/api/sync/retry` · `/api/sync/pull` | Retry push / fetch remote |
| GET | `/api/conflicts` | Conflict list |
| POST | `/api/conflicts/resolve` | keep-mine / keep-theirs |
| GET/POST/DELETE | `/api/credentials` | Encrypted HTTPS PAT |

Product intent and acceptance criteria: [docs/specs/](docs/specs/).

---

## Card format

```markdown
---
id: c-8f3a
title: Refactor auth middleware
column: doing
order: "a0"
updated: 2026-08-04T12:53:00Z
labels: [backend]
---

## Status
What is true right now (overwrite on each change).

## Log
- 2026-08-04 claude: created
```

Agents should follow `AGENTS.md` in the boards repo (or run `kanbanly skill-install`).

---

## License

AGPL-3.0-or-later for this monorepo. See [LICENSE](LICENSE).

Private SaaS (S3, multi-tenant AI): [billiondollarsolo/kanbanly-saas](https://github.com/billiondollarsolo/kanbanly-saas).
