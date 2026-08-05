# kanbanly

Self-hosted, multi-project kanban whose data lives in **git** as markdown cards.
Agents and the UI are independent clients of the same remote.

**Core principle: git is the only contract.**

## Layout

| Path | What |
|------|------|
| `packages/core` | `@kanbanly/core` — card schema, order, merge, heal, Git/S3 storage, setup, AI tools (AGPL boundary) |
| `packages/server` | `@kanbanly/server` — OSS HTTP API, SSE, push queue, multi-remote registry |
| `apps/web` | React board UI (built into `packages/server/public`) |
| `apps/start` | TanStack Start board (optional docs stack) |
| `kanbanly-saas/` | Closed SaaS (S3, device auth, AI confirm-before-write, export) |
| `fixtures/` | Layout-A sample boards |
| `docs/specs/` | Product specification |
| `bin/kanbanly` | Cross-runtime CLI entry (Bun preferred, Node 22+ fallback) |

## Quick start (OSS)

```bash
bun install
bun run build          # board UI → packages/server/public
bun test               # core + server
bun run typecheck
bun run lint
bun run test:conformance

# Serve a boards repo (loopback by default)
./bin/kanbanly serve --repo ./fixtures/boards-layout-a
# → http://127.0.0.1:3847/

# Or:
bun run packages/server/src/cli.ts serve --repo ./fixtures/boards-layout-a
```

### TanStack Start

```bash
KANBANLY_REPO=$PWD/fixtures/boards-layout-a bun run dev:start
# → http://127.0.0.1:3000/
```

## CLI

```text
kanbanly serve [--host 127.0.0.1] [--port 3847] [--repo <path>]
kanbanly merge-driver <ancestor> <ours> <theirs>
kanbanly setup --code <path> --boards <path> --remote <url> [--board backend]
kanbanly skill-install [--path <dir>]
```

Non-loopback `--host` prints a loud warning (no auth on OSS).

## HTTP API (OSS)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/health` | Liveness + sync + credentials status |
| GET/POST | `/api/connect` | Connect wizard (local path or remote URL) |
| GET | `/api/remotes` | Multi-remote sidebar |
| POST | `/api/remotes/active` | Switch active remote `{ slug }` |
| GET | `/api/boards` | List boards |
| GET | `/api/boards/:id` | Board + cards |
| POST | `/api/boards/:id/cards` | Create card |
| POST | `/api/boards/:id/cards/:cid/move` | Move card |
| PATCH | `/api/boards/:id/cards/:cid` | Update fields |
| GET | `/api/boards/:id/cards/:cid/history` | `git log --follow` |
| POST | `/api/boards/:id/archive` | Archive cards |
| GET | `/api/events` | SSE board updates |
| GET | `/api/sync` | Push queue status |
| POST | `/api/sync/retry` | Flush push queue |
| POST | `/api/sync/pull` | Fetch + ff-only + heal markers |
| POST | `/api/sync/clear-freeze` | Unfreeze after conflicts |
| GET/POST | `/api/conflicts` | List / resolve keep-mine|theirs|heal |
| GET/POST/DELETE | `/api/credentials` | HTTPS PAT store (encrypted) |
| GET | `/api/pr-status?pr=` | PR overlay |

Deep links (US-15):

- Path (preferred): `/b/<board>/<card?>` or `/r/<remote>/b/<board>/<card?>`
- Hash (compat): `#/b/...` or `#/r/...`

## Keyboard

| Key | Action |
|-----|--------|
| Arrows / hjkl | Focus cards |
| Shift+←/→ | Move card columns |
| Enter / Space | Open detail |
| x | Multi-select |
| Esc | Close / clear |
| ? | Shortcuts help |

## Docker

```bash
docker build -t kanbanly .
docker run --rm -p 127.0.0.1:3847:3847 \
  -v "$PWD/fixtures/boards-layout-a:/boards" \
  kanbanly serve --host 0.0.0.0 --repo /boards
```

Healthcheck hits `/health`.

## SaaS

```bash
cd kanbanly-saas && bun install && bun test
bun run start -- --port 3850 --s3-dir ./.kanbanly-saas-s3
# → http://127.0.0.1:3850/chat
```

- FileS3 / InMemory / AWS S3 (`AwsS3Client.fromEnv`)
- Device-code auth scaffold
- AI tools with **confirm-before-commit**
- CORS enabled on JSON APIs
- `GET /api/tenants/:tid/boards` and `.../boards/:bid`

## Card format

```markdown
---
id: c-8f3a
title: Refactor auth middleware
column: doing
order: "a0"
updated: 2026-08-04T12:53:00Z
---

## Status
What is true right now.

## Log
- 2026-08-04 claude: created
```

## License

AGPL-3.0-or-later for the public monorepo. Closed SaaS imports `@kanbanly/core` under a private grant.
