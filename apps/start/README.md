# @kanbanly/start

TanStack Start app for kanbanly OSS — file routes + server functions over `@kanbanly/core` / `@kanbanly/server`.

## Run

From monorepo root (git fixture must exist):

```bash
# Ensure fixture is a git repo if needed
cd fixtures/boards-layout-a && git init && git add . && git commit -m init; cd ../..

KANBANLY_REPO=$PWD/fixtures/boards-layout-a bun run dev:start
```

- `/` redirects to first board  
- `/b/$boardId` — full board UI (DnD, filters, detail, quarantine, theme, keyboard)

## Architecture

| Layer | Role |
|--------|------|
| `src/routes/*` | TanStack Router file routes |
| `src/server/board-fns.ts` | `createServerFn` wrappers |
| `src/server/board-service.ts` | Plain handlers (unit-testable without Start ALS) |
| `src/server/session.ts` | Singleton git clone + LiveHub + PushQueue |
| `src/components/board/*` | Ported board UI (calls server fns via `api.ts`) |

Env:

- `KANBANLY_REPO` — path to boards git repo (required outside monorepo fixture default)
- `KANBANLY_POLL_MS` — live poll interval (default 15000)
- `KANBANLY_PUSH_DEBOUNCE_MS` — push queue debounce (default 2000)

## Tests

```bash
bun test apps/start
```
