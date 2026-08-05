# Project cockpit — multi-project AI boards

**Purpose.** Use kanbanly so a human can track **dozens of AI-built projects** at a glance: task status, agent work, project notes, and **code-repo commit history** (the app being built — not the boards git log).

**Source of truth.** Boards git repo (markdown cards + notes). Optional **code binding** per board points at a separate project git clone for History.

---

## Product ideas (full roadmap)

### Phase 1 — shipped in this plan’s execution (gating)

| Feature | Behavior |
|---------|----------|
| **Code binding** | `board.yml` `settings.code.path` (local project clone) and optional `settings.code.remote` |
| **Project History** | Board chrome **History** → commits from **bound code repo** (`git log`), not boards `chore(board):` |
| **Project Notes** | Board chrome **Notes** → `NOTES.md` under the board dir, committed to boards repo |
| **Agent contract** | Skill + `AGENTS.md`: board is SoT; session start/end; Status/Log; notes; log commit SHAs |
| **Empty states** | No binding → clear message (not boards-repo history) |

### Phase 2 — portfolio / at-a-glance (shipped)

- **Projects home** (default landing): grid of boards with health, column counts, P0, last agent
- **Velocity per tile**: done/7d, agent logs/7d, code commits/7d+24h (when bound), pulse age
- **Cross-board activity** feed on portfolio home
- **Health rank**: stale / silent / blocked / busy / healthy / idle (sort attention first)
- **Stale badges**: Doing > 48h; fleet-health for silent / WIP over

### Phase 3 — agent pickup & discipline

- Template columns: Inbox → Ready → Doing → Blocked → Review → Done
- Skill: only pick Ready / assigned Doing
- Optional `kanbanly session-end` CLI that records a Log line
- WIP limits on Doing

### Phase 4 — deeper code integration

- Clone-on-demand from `settings.code.remote` with credential book
- GitHub commit deep-links when remote is GitHub
- Match commit messages mentioning `c-…` to cards
- PR overlay already exists; keep tied to `pr:` frontmatter

### Phase 5 — unattended fleet ops

- [x] `GET /api/fleet-health` — P0, stale Doing, silent pulse, WIP over, empty Ready
- [x] Hard WIP (`settings.wipHard`) → 409 on move into Doing when over limit
- [x] `POST …/session-end` HTTP + `session_end` / `fleet_health` agent tools
- [x] Fleet digest: `kanbanly fleet-digest`, `?format=text`, Slack-compatible `--webhook`
- [ ] Multi-user OSS auth (still non-goal for loopback OSS)

---

## Reasoning

1. **Separate process vs delivery.** Card logs + activity = process. Code `git log` = what shipped in the product.
2. **Git-native notes.** `NOTES.md` survives clones, agents, and remotes the same way cards do.
3. **Binding in `board.yml` settings.** Survives push/pull; no dependency on only `~/.kanbanly/workspace.json` for SoT (workspace may still cache UI state).
4. **Local path first.** Tests and offline OSS work without network; remote clone is Phase 4.

---

## Data model

### Code binding (`board.yml`)

```yaml
id: b-…
title: Product
columns: […]
settings:
  code:
    path: /Users/you/code/app-x   # absolute path to project git root
    remote: https://github.com/you/app-x.git  # optional documentation / later clone
```

Resolution: `settings.code.path` must exist and contain `.git` (or be a git work tree). If missing → history API returns `bound: false`.

### Notes

```text
<boardDir>/NOTES.md
```

Committed with `chore(board): update NOTES.md (…)`.

### History DTO

```ts
{ sha, date, author, subject }[]  // from code repo git log only
```

---

## API (Phase 1)

| Method | Path | Notes |
|--------|------|--------|
| GET | `/api/boards/:id/notes` | `{ body, path }` |
| PUT | `/api/boards/:id/notes` | `{ body }` → commit |
| GET | `/api/boards/:id/code-history?limit=50` | Project commits; `bound: false` if unbound |
| PATCH | `/api/boards/:id/code-binding` | `{ path?, remote? }` → board.yml settings |

---

## UI (Phase 1)

Board navbar: **Notes** and **History** buttons (modals, same family as card modal).

- History title: “Project commits” / empty: “Link a project repo…”
- Notes: textarea + Save

---

## Agent contract (skill + AGENTS.md)

1. Session **start**: read board columns, open cards, `NOTES.md`, code binding if present.
2. Work only via a **card** (create if needed); move to Doing; set assignee.
3. Overwrite **Status**; append **Log** (`YYYY-MM-DD agent: …`).
4. After code commits: Log the **short SHA** on the card.
5. Session **end**: Status + Log; never leave progress only in chat.
6. Update **NOTES.md** for durable decisions/risks (sparingly).

---

## Test notes

- Real temp **code** repo with commits; bind board `settings.code.path`; assert history subjects match **code** commits, not board chore messages.
- Unbound board → `bound: false`, empty entries.
- Notes PUT then GET round-trip; file exists under board dir; boards git has commit.
- Skill/AGENTS string markers for session rules.

### Later-phase checklists (not Phase-1 gate)

#### Phase 2 portfolio
- [x] Projects grid API aggregating boards + activity timestamps (`GET /api/portfolio`)
- [x] Tile UI with counts / last pulse (**Projects** home)
- [x] Cross-board activity on portfolio home
- [x] P0 + stale-doing badges on tiles
- [x] Velocity on tiles (done/7d, agent logs/7d, code commits/7d+24h, pulse age, health)
- [x] Portfolio is default home (`/`); connect wizard lands on Projects

#### Phase 3 pickup
- [x] Default column template on createBoard (Inbox→Ready→Doing→Blocked→Review→Done + wipDoing)
- [x] Skill Ready-only pickup rule + canAgentPickup helper
- [x] `kanbanly session-end` CLI (Log + optional Status/SHA)
- [x] Soft WIP banner + portfolio WIP badge
- [x] `kanbanly session-start` CLI (notes + ready/doing + commits brief)
- [x] Commit subjects mentioning `c-…` linked to cards in History UI

#### Phase 4 code remote
- [x] Clone code remote into `~/.kanbanly/code-clones/` (`ensureCodeRepo` + `POST …/code-source`)
- [x] Credential reuse for fetch (token / book / boards store)
- [x] Agent tools: `get_notes`, `list_project_commits`, `set_code_binding`, `update_notes`
- [x] Optional GitHub commit deep-links in UI (when `settings.code.remote` is GitHub)

#### Phase 5 fleet digest
- [x] `formatFleetDigest` / `fleetWebhookPayload` pure helpers
- [x] `kanbanly fleet-digest --repo … [--json] [--fail-on-high] [--only-issues] [--webhook URL]`
- [x] `GET /api/fleet-health?format=text` (or `Accept: text/plain`)
- [x] Skill documents cron + webhook pattern

---

## Phase 1 task checklist (implementation)

- [x] This document
- [x] Core helpers + GitStorage code history + notes
- [x] Server HTTP routes
- [x] Web UI History + Notes
- [x] Skill + AGENTS
- [x] Tests + scratch evidence + web build
