---
name: kanbanly
description: >
  Work with kanbanly boards — git-backed markdown kanban for humans and agents.
  Use when creating/moving cards, wiring a boards remote, project notes, project
  commit history, installing setup, or reading AGENTS.md conventions.
---

# kanbanly skill

**Kanban for ADHD.** Boards are ordinary git repos of markdown cards. The UI and agents share the same files.

**The board is the source of truth** for multi-project AI work — not chat.

## When to use

- Tracking status across projects built with AI agents
- Creating/moving cards, updating Status/Log
- Reading/writing **project notes** (`NOTES.md`)
- Viewing **project code commits** (bound code repo — not boards-repo history)
- Wiring `.kanbanly.yml` or a boards remote

## Unattended multi-agent fleet

When **tens of agents** run hours-long sessions without a human watching:

1. **One card per agent** — never steal Doing assigned to another agent.
2. **Pickup only Ready** (or your Doing). Hard rule.
3. **Heartbeat** — update Status/Log at least every few hours while working (avoids `no_pulse` / `stale_doing` on fleet health).
4. **session_end is mandatory** before exit:
   ```bash
   # CLI
   kanbanly session-end --repo <boards> --board <id> --card <id> \
     --summary "…" --sha <short> --agent <name>
   # or HTTP
   POST /api/boards/:boardId/cards/:cardId/session-end
   { "summary": "…", "agent": "…", "sha": "…", "status": "…" }
   ```
5. **Monitor** fleet health (stuck/silent agents, P0s, WIP over):
   ```bash
   # Text digest (cron-friendly)
   kanbanly fleet-digest --repo <boards> --fail-on-high
   # Only when broken + optional Slack/Discord webhook
   kanbanly fleet-digest --repo <boards> --only-issues --webhook "$HOOK_URL" --fail-on-high
   # HTTP
   curl -sf "$BASE/api/fleet-health?format=text"
   # Agent tool
   fleet_health
   ```
6. **WIP**: prefer soft limit 3; if board `settings.wipHard: true`, moves into Doing past limit return **409**.

## Session protocol (required)

### Start
1. Prefer:
   ```bash
   kanbanly session-start --repo <boards> --board <id> --agent <name>
   ```
   (prints notes preview, Ready/Doing, WIP, recent project commits).
2. Or: list boards / open board; read **NOTES.md**; scan Ready / Doing / P0.
3. If source is bound, use `list_project_commits` / History for product `git log`.

### Pickup
- **Only** start from **Ready**, or continue **Doing** assigned to you (or unassigned).
- Never take Inbox / Blocked / Review / Done without human reassignment.
- Keep **Doing WIP ≤ 3** when possible (`settings.wipDoing`).

### During
1. Create or pick a **Ready** card before coding.
2. Move to Doing; set `assignee` to your agent id.
3. Overwrite `## Status`; append `## Log` (`YYYY-MM-DD agent: …`).
4. After code commits: Log the **short SHA** on the card.
5. Open PR → set `pr:` and move to **Review**.

### End
1. Final Status + Log — prefer:
   ```bash
   kanbanly session-end --repo <boards> --board <id> --card <id> \
     --summary "what landed" --sha <short> --agent <name>
   ```
2. Update NOTES.md only for durable decisions.
3. Never leave progress only in chat.

## Project notes

`GET/PUT /api/boards/:id/notes` or edit `NOTES.md` under the board directory.

## Project commit history (source code repo)

`GET /api/boards/:id/code-history` — product commits only (never boards `chore(board):`).

### Attach source (recommended)

User or agent binds a **source code** remote; server clones into `~/.kanbanly/code-clones/`:

```bash
# Remote + PAT (Contents R/W)
curl -X POST "$BASE/api/boards/<boardId>/code-source" \
  -H 'content-type: application/json' \
  -d '{"url":"https://github.com/you/app.git","token":"'"$GITHUB_PAT"'"}'

# Or local path already on the machine
curl -X PATCH "$BASE/api/boards/<boardId>/code-binding" \
  -H 'content-type: application/json' \
  -d '{"path":"/absolute/path/to/code/repo"}'
```

UI: board **History** → remote URL + optional PAT → **Connect source**.

### Agent tools (when runtime exposes them)

| Tool | Kind | Purpose |
|------|------|---------|
| `get_notes` | read | Project NOTES.md |
| `list_project_commits` | read | Code-repo `git log` |
| `set_code_binding` | write (confirm) | Bind path/remote |
| `update_notes` | write (confirm) | Save NOTES.md |

Session start: `get_notes` + `list_project_commits` for the board. After code commits: append short SHA to card Log.

## Card format

```markdown
---
id: c-a1b2c3d4e5f60718293a4b5c
title: Example task
column: doing
order: "a0"
priority: P1
labels: [backend]
assignee: agent
updated: 2026-08-05T12:00:00Z
---

## Status
Implementing auth middleware.

## Log
- 2026-08-05 agent: created
- 2026-08-05 agent: code commit a1b2c3d — auth scaffold
```

Rules: 24-hex ids; agents append order only; Status overwrite; Log append-only; re-read before write.

## CLI / Docker

```bash
docker compose -f deploy/compose.yaml up --build
bun run kanbanly -- skill-install
bun run kanbanly -- setup --code . --boards ../boards --remote <url>
```

## API quick ref

```bash
BASE=http://127.0.0.1:3847
curl -sf "$BASE/api/boards"
curl -sf "$BASE/api/portfolio"
curl -sf "$BASE/api/fleet-health"
curl -sf "$BASE/api/fleet-health?format=text"
curl -sf "$BASE/api/boards/<id>/notes"
curl -sf -X PUT "$BASE/api/boards/<id>/notes" -H 'content-type: application/json' -d '{"body":"# Notes\n"}'
curl -sf "$BASE/api/boards/<id>/code-history"
curl -sf -X PATCH "$BASE/api/boards/<id>/code-binding" -H 'content-type: application/json' \
  -d '{"path":"/path/to/project"}'
```

Never put PATs in chat or commits.
