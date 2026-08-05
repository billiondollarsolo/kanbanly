# kanbanly — Specification

**Status:** Ready for implementation
**Date:** 2026-08-04
**Slug:** `i-want-to-create-a-kanban-board-that-can-host-multiple-separ`

---

## 1. Overview

kanbanly is a self-hosted, multi-project kanban board whose data lives in git repositories
as markdown files. Coding agents (Claude, Codex, Grok, …) create cards, move them, and write
human-readable status narratives as they work. A hosted SaaS offers the same product managed,
with S3 storage, an AI assistant, and one-click export back to git.

## 2. Problem Statement

Coding agents do substantial work but leave no durable, human-legible record of what they did,
what they're doing, or what they discovered along the way. Existing trackers are SaaS-only,
API-driven, and hostile to agents that are good at editing files and running git.

kanbanly makes the tracker a git repo of markdown, so an agent updates the board with the
tools it already has, and a human reads the result as prose.

**Core principle: git is the only contract.** The UI and the coding agent are independent
clients of the same remote. No API between them, no auth between them, neither needs to know
the other exists. A teammate in another timezone and an agent on your laptop are the same case.

---

## 3. Scope

### In Scope (MVP)

- Card format: markdown + YAML frontmatter, `## Status` / `## Log` conventions
- Boards stored in dedicated git repo(s), addressed as `(remote, path)`
- Two layouts: one boards repo with a directory per board, or one repo per board
- `.kanbanly.yml` pointer committed in the code repo
- `@kanbanly/core` shared package: Zod schema, ID/order rules, merge driver, storage adapters
- Custom git merge driver with a designed conflict-marker fallback
- OSS server: connect boards repo, render, drag-and-drop, card edit, quick-add, archive
- Multi-board and multi-boards-repo
- Poll + SSE live updates
- Optimistic UI → local commit → background push queue
- `pr:`-linked pending-work overlay
- Installable setup skill + in-repo `AGENTS.md` conventions
- Filter bar, keyboard navigation, board activity feed
- Light/dark theme with an explicit switch
- Five explicit error states

### Out of Scope

- Real-time multiplayer presence, cursors, CRDT co-editing (SSE-after-commit is the ceiling)
- AI assistant in OSS (SaaS-only)
- WIP limits
- Standalone compiled binary (Docker + npm only)
- Enterprise self-deploy of the SaaS stack

### Post-MVP Roadmap

- Import from Trello / Jira / Linear
- Public read-only share links
- Outbound webhooks / events API
- Audit log (free from `git log` in OSS; Postgres-backed view in SaaS)
- One-way GitHub Issues import; two-way Issues sync

---

## 4. Technical Design

### 4.1 Card Format

```markdown
---
id: c-8f3a
title: Refactor auth middleware
column: doing
order: "0|hzzzzz:"
priority: P1
labels: [backend, security]
assignee: claude
due: 2026-08-09
pr: mj/api-service#418
updated: 2026-08-04T12:53:00Z
---

## Status
Auth middleware split into validate/issue. Tests green.
JWT rotation still open — blocked on picking a key store.

## Log
- 2026-08-02 claude: created from issue #214
- 2026-08-03 claude: extracted validateSession()
- 2026-08-04 claude: tests green, 12 added
- 2026-08-04 claude: blocked — key store TBD
```

- `## Status` — **overwritten** on every state change. The "now".
- `## Log` — **append-only**, dated and attributed. The "how we got here". Union-merges.

### 4.2 Repository Layout

```
# layout A — one boards repo, directory per board
kanbanly-boards/
  AGENTS.md              ← agent conventions, single source of truth
  backend/  board.yml  cards/  cards/archive/
  web/      board.yml  cards/

# layout B — one repo per board
kanbanly-backend/
  AGENTS.md
  board.yml  cards/
```

The code repo carries a two-line committed pointer:

```yaml
# .kanbanly.yml
remote: git@github.com:mj/kanbanly-boards.git
board:  backend          # omitted in layout B
```

Plus a pointer line appended to root `AGENTS.md` **and** root `CLAUDE.md`. This makes the
system self-describing: one committed file lets any agent on any machine find both the data
and the rules, with nothing installed.

### 4.3 Card Identity & Ordering

- **ID:** `c-` + 4–6 random base36 chars. Filename `<id>-<title-slug>.md`. Unique per board;
  agent scans that board's `cards/` and retries on the ~1-in-1.6M collision.
- **Order:** fractional index string. **Agents always append to the end** — read the target
  column, take the largest `order`, mint a key after it. Humans drag anywhere, minting between
  neighbours. Identical keys tiebreak on card id, lower first.

### 4.4 Stack

All TypeScript. Go was evaluated and dropped — its only advantage was a small static binary,
and OSS ships Docker + npm only.

```
kanbanly/                      AGPL-3.0 + CLA, public
  packages/core/               @kanbanly/core
    card schema (zod)          ← one definition, four consumers
    id + order-key rules
    merge driver
    storage adapters: git | s3 ← one interface, two impls
    ai tool definitions
  packages/server/             OSS app entry
  apps/web/                    TanStack Start (full-stack)
  deploy/
    compose.yaml
    chart/                     Helm chart

kanbanly-saas/                 closed
  "@kanbanly/core": "^1.x"     under private grant
  + tenants, auth, billing, AI service, portfolio view
```

**Why the shared core matters:** one Zod schema validates card frontmatter on parse, validates
API request bodies, generates the JSON Schema for TanStack AI's `toolDefinition`, and types the
client. "What is a card" is stated once and enforced in four places.

- **Runtime: Bun.** ⚠️ `npx` users land on Node, so the package must stay Node-compatible on a
  best-effort basis; `bunx kanbanly` is the documented path. Both need testing per release.
- **Distribution: Docker + npm only.** No standalone binary.
- **Requires `git` in `$PATH`** — the server shells out to the real git CLI, which is required
  for worktrees, `.gitattributes`, and custom merge drivers.
- **Frontend: TanStack Start, full-stack** — server functions, SSR, file-based API routes,
  end-to-end type safety. Plus TanStack Router / Query / Table / Form; TanStack AI in SaaS.
- **Drag and drop: Atlassian Pragmatic drag-and-drop** (`+ /auto-scroll` + `/hitbox`) — the
  same engine behind Trello and Jira. TanStack has no DnD library.

### 4.5 Write Paths

| Actor | Path |
|---|---|
| OSS server | Own clone at `~/.kanbanly/repos/<hash>/`. Reads, writes, commits, pushes. |
| OSS agent | Own clone at `~/.cache/kanbanly/<hash>/`. Edits files, commits, pushes. |
| SaaS agent | Authenticated HTTPS API. No clone. |
| Human (UI) | Server writes on their behalf, always to the default branch. |

**Separate clones, synced through the remote.** No git index/lock contention, and it's the same
path a remote teammate takes. Cost: agent changes appear after push plus the server's next fetch
(~15s worst case) — accepted, no local special-casing.

**Credentials:** the agent uses the developer's existing SSH agent or git credential helper —
zero kanbanly-specific setup. The server keeps its own credential encrypted at rest
(`~/.kanbanly/creds.age`, 0600; key at `~/.kanbanly/key`, 0600) or uses a mounted SSH key.

### 4.6 Latency

```
drag drop
  → TanStack Query optimistic update   (0ms)
  → server function
  → write file + git commit            (~10ms)
  → confirmed
  → push queued, debounced ~2s         (rapid drags coalesce)
```

Header indicator: `● N changes syncing…` / `✓ synced` / `⚠ push failed — retry`.

### 4.7 Conflict Resolution

- Push rejected → `git pull --rebase` → re-push, up to 3 attempts.
- `.gitattributes` (committed in the boards repo): `**/cards/*.md merge=kanbanly`
- Driver: `kanbanly merge-driver %O %A %B %L %P`
- ⚠️ **Git deliberately does not let a repo define what a driver name executes** (cloning would
  run arbitrary code), so it must be installed per-clone via `git config`. Both `kanbanly setup`
  and the server do this in their clones.
- **Designed fallback:** a clone without the driver produces ordinary `<<<<<<<` markers → the
  server detects conflicted card files on fetch, heals with the same logic, commits.
- Driver logic: frontmatter → higher `updated:` wins; `## Log` → union, dedupe, re-sort;
  `## Status` → higher `updated:` wins.
- ⚠️ **Never plain `merge=union` on frontmatter** — it yields duplicate YAML keys (`column:`
  twice) which most parsers silently resolve to the last one. This is the silent-data-loss
  hazard the fixture tests exist to guard.

### 4.8 Server State

No database. `~/.kanbanly/`: `config.json`, `creds.age`, `key`, `queue.json`, `repos/<hash>/`.
In-memory index `index[remote] = { sha, boards, cards }`, rebuilt only when the SHA changes.
Fetch returning the same SHA costs nothing.

### 4.9 Pending-Work Overlay

Cards declare their work link; kanbanly reads PR state from the forge:

```
---
id: c-8f3a
column: doing
pr: mj/api-service#418
---

  ┌─ c-8f3a ───────────┐
  │ Refactor auth      │
  │ ┗╸ PR #418 · open  │
  │    ⇒ lands REVIEW  │
  └────────────────────┘
```

Requires the agent to declare `pr:`/`branch:` when it starts, and read access to PR metadata
(never file contents).

### 4.10 Agent Conventions (`AGENTS.md` at boards repo root)

- Move to Doing on start, Review on PR open, Done on finish.
- Append a Log line at each meaningful step (with worked examples); rewrite Status on every
  state change.
- File a card for unplanned work discovered mid-task instead of silently expanding scope.
- Never edit another author's Log entries.
- Card ID, order, and collision procedures, as executable steps.
- Re-read before write when sharing a checkout (documented known limit; no lock files).

### 4.11 SaaS

- **S3, one object per card**, git-identical format. Write: `GET` → ETag → `PUT` with
  `If-Match` → `412` retry. **Conditional writes make the merge driver unnecessary in SaaS.**
  Bucket versioning on.
- **Postgres** holds tenants, users, auth, billing, chat history, audit log.
- **Auth:** device-code login. `kanbanly login` → browser approval → token in `~/.kanbanly/`.
  The credential never passes through the agent or the transcript.
- **AI assistant (SaaS-only):** TanStack AI (`@tanstack/ai` + `@tanstack/ai-anthropic` +
  `@tanstack/ai-react`), served from a Start server route via `chat()` +
  `toServerSentEventsResponse()`, consumed with `useChat`. Model: **`claude-opus-5`**.
  Tool-driven, not prompt-stuffed. Read tools: `list_cards`, `get_card`, `board_summary`,
  `search_cards`, `card_history`. Write tools: `create_card`, `move_card`, `update_status`,
  `add_label` — **all writes require an in-chat confirm chip before committing.**
- **Export:** one-click "push to my GitHub" materializes S3 into a real git repo (optionally
  replaying object versions as commits), plus a downloadable `.bundle`.
- **Deployment:** Helm chart + Compose file, operated by us. Chart values cover image tag,
  replicas, resources, ingress, S3 config, and Postgres as either CloudNativePG in-cluster or
  an external URL. Not shipped as an enterprise self-deploy tier.
- **Pricing:** deferred.

### 4.12 License

**AGPL-3.0 + contributor CLA.** Copyright retained, so the closed SaaS repo imports
`@kanbanly/core` under a private grant.

---

## 5. User Experience

### 5.1 Flows

**First run (OSS):** empty state → connect a boards repo by URL (or offer to create one) →
optional credential (SSH agent or PAT) → clone → render. Linking GitHub for `pr:` overlay
state is a separate, later, optional step.

**Setup in a code repo:** agent runs `/kanbanly setup` → writes `.kanbanly.yml`, appends
pointer lines to root `AGENTS.md` and `CLAUDE.md`, writes `.gitattributes`, configures the
merge driver.

**Navigation:** sidebar lists connected boards repos → boards. One board at a time. No
cross-repo aggregate view in OSS (SaaS value). URLs: `/r/<remote-slug>/b/<board>` and
`/r/<remote-slug>/b/<board>/<cardid>`.

**Card detail:** side panel, board stays visible. Frontmatter as form controls
(labels/assignee/due), `## Status` editable inline, `## Log` read-only.

**Card create:** `+ Add card` per column, title only → minimal card committed
(`## Status: _Not started._`, Log line attributed to the human). Agent enriches later.

**Archive:** Done column shows the 20 most recent plus `[ Archive N older cards ]` → `git mv`
into `cards/archive/`, skipped by the index. Nothing deleted.

### 5.2 Visual Direction

Clean, calm product identity — **no mascot**. The `-ly` name suggests a tool that gets out of
the way: muted palette, strong typography, generous whitespace.

**Light and dark mode with an explicit switch** (light / dark / system), persisted per browser,
defaulting to system preference. Both themes are first-class — no unreadable contrast in either.

### 5.3 Error States

| State | Handling |
|---|---|
| Credential invalid/expired/missing scopes | Banner naming the missing scope + re-enter flow |
| Offline / remote unreachable | Local commits keep working, pushes queue, `offline — N changes pending`, drains on reconnect |
| Malformed frontmatter | Card renders broken in a quarantine lane with the parse error; never takes down the board render |
| Unknown `column:` id | `⚠ Unknown column: qa (3)` lane with a one-click "move all to →" picker; one commit rewrites the affected cards. Nothing auto-moves without consent |
| Unresolvable conflict after 3 attempts | Freeze that repo's sync, show diverged cards with both sides, keep-mine / keep-theirs |

### 5.4 Security Posture (OSS has no login, by decision)

- Binds `127.0.0.1` by default. `--host` prints a loud warning that anyone reachable can push
  to connected repos.
- Credentials encrypted at rest.
- ⚠️ **Stated and accepted risk:** an exposed no-auth instance hands push access to anyone on
  the network.
- Telemetry: none by default. Optional `check_updates: true` hits the GitHub releases API only.

---

## 6. Requirements

### Functional

- **FR-1** — Parse and serialize a card file: YAML frontmatter + `## Status` + `## Log` sections.
- **FR-2** — Validate card frontmatter against a Zod schema; surface parse errors without
  crashing the board render.
- **FR-3** — Generate collision-free card IDs by scanning the target board's `cards/`.
- **FR-4** — Mint fractional order keys: append-after-last, insert-between, tiebreak on id.
- **FR-5** — Parse `board.yml`: columns (id + display name), labels, settings.
- **FR-6** — Merge driver resolving frontmatter by `updated` timestamp and union-merging Log.
- **FR-7** — Detect and heal conflict-markered card files on fetch.
- **FR-8** — Git storage adapter: clone, read board, write card, commit, push, rebase-and-retry.
- **FR-9** — `kanbanly setup` scaffolds a boards repo, writes `.kanbanly.yml`, pointer lines,
  `.gitattributes`, and merge-driver git config.
- **FR-10** — `kanbanly skill install` detects harness skill directories and installs the skill.
- **FR-11** — Connect a boards repo by URL with an optional credential; clone and render.
- **FR-12** — Render a board: columns from `board.yml`, cards sorted by `order`.
- **FR-13** — Maintain an in-memory index keyed by commit SHA; rebuild only on SHA change.
- **FR-14** — Poll `git fetch` on a configurable interval; push changes to browsers via SSE.
- **FR-15** — Drag a card between and within columns; mint the new order key; commit.
- **FR-16** — Queue pushes with a ~2s debounce; surface sync state in the header.
- **FR-17** — Create a card from the board with a title only.
- **FR-18** — Edit card frontmatter fields and `## Status` from the detail panel.
- **FR-19** — Archive done cards into `cards/archive/` via `git mv`.
- **FR-20** — Render `pr:`-linked pending state on cards from forge PR metadata.
- **FR-21** — Filter by label, assignee, and free-text search.
- **FR-22** — Navigate and move cards by keyboard.
- **FR-23** — Show a board-level activity feed rolling up every card's Log.
- **FR-24** — Toggle light / dark / system theme; persist per browser.
- **FR-25** — Handle all five error states in §5.3.

### Non-Functional

- **NFR-1** — 2,000 cards per boards repo without degradation.
- **NFR-2** — Full re-index in under 500ms on SHA change.
- **NFR-3** — Board render in under 100ms from the in-memory index.
- **NFR-4** — Fetch returning an unchanged SHA performs no parsing work.
- **NFR-5** — Server binds `127.0.0.1` unless explicitly overridden.
- **NFR-6** — Credentials stored encrypted at rest with 0600 permissions.
- **NFR-7** — No telemetry or outbound network calls except to the configured git remote and
  (optionally) the GitHub releases API.
- **NFR-8** — Both light and dark themes meet WCAG AA contrast.
- **NFR-9** — The npm package runs under Node as well as Bun (best-effort).

---

## 7. User Stories

Each story is sized for one focused coding session.

### Phase 1 — Format & Skill (`@kanbanly/core`, no server)

#### US-1: Card schema and parser
**As a** developer, **I want** a Zod schema and parser for card files **so that** every consumer
validates cards identically.

**Acceptance Criteria:**
- [ ] `parseCard(text)` returns `{ frontmatter, status, log }` for a valid card
- [ ] Frontmatter validates against a Zod schema; `id`, `title`, `column`, `order`, `updated` required
- [ ] `serializeCard(card)` round-trips: `parseCard(serializeCard(c))` deep-equals `c`
- [ ] Invalid YAML returns a typed parse error, never throws
- [ ] Missing `## Status` or `## Log` sections parse as empty, not errors
- [ ] `bun test` passes; `bun run typecheck` passes

#### US-2: Card ID generation
**As an** agent, **I want** collision-free IDs **so that** two agents can create cards without
coordinating.

**Acceptance Criteria:**
- [ ] `generateCardId(existingIds)` returns `c-` + 4–6 base36 chars not in `existingIds`
- [ ] Retries on collision; test with a seeded generator forcing 3 collisions
- [ ] `cardFilename(id, title)` returns `<id>-<slugified-title>.md`
- [ ] Slugification handles unicode, punctuation, and >80-char titles
- [ ] `bun test` passes

#### US-3: Fractional order keys
**As a** user, **I want** drag-anywhere ordering **so that** the board reflects my priorities.

**Acceptance Criteria:**
- [ ] `orderAfter(last)` returns a key sorting after `last`
- [ ] `orderBetween(a, b)` returns a key sorting strictly between them
- [ ] `orderBetween(null, first)` returns a key sorting before `first`
- [ ] 1,000 sequential `orderBetween` inserts at the same position stay correctly ordered
- [ ] Identical keys tiebreak on card id, lower first
- [ ] `bun test` passes

#### US-4: `board.yml` schema and parser
**As a** user, **I want** to define my own columns **so that** the board matches my workflow.

**Acceptance Criteria:**
- [ ] `parseBoard(text)` returns columns (id + name, ordered), labels, settings
- [ ] Duplicate column ids return a validation error
- [ ] A card referencing an unknown column id is flagged, not dropped
- [ ] `bun test` passes

#### US-5: Merge driver
**As a** user, **I want** concurrent card edits to merge cleanly **so that** I never silently
lose work.

**Acceptance Criteria:**
- [ ] `mergeCards(base, ours, theirs)` resolves frontmatter keys by higher `updated`
- [ ] `## Log` entries union, dedupe, and re-sort by date
- [ ] `## Status` resolves by higher `updated`
- [ ] Fixture table covers: both moved column, both appended Log, one renamed title, one
      archived — each with expected merged output
- [ ] **Output is never duplicate-keyed YAML** — explicit test asserting a single `column:` key
- [ ] `bun test` passes

#### US-6: Conflict-marker healing
**As a** user, **I want** the server to repair conflicts from clones without the driver
**so that** an un-configured teammate can't break the board.

**Acceptance Criteria:**
- [ ] `healConflict(text)` detects `<<<<<<<` / `=======` / `>>>>>>>` in a card file
- [ ] Extracts both sides and resolves them with the same `mergeCards` logic
- [ ] Returns unchanged text when no markers are present
- [ ] Test drives a real conflict in a temp repo with the driver *not* installed
- [ ] `bun test` passes

#### US-7: Git storage adapter
**As a** developer, **I want** one storage interface **so that** git and S3 are interchangeable.

**Acceptance Criteria:**
- [ ] `GitStorage` implements `listBoards`, `readBoard`, `readCard`, `writeCard`, `moveCard`
- [ ] `writeCard` writes, commits with a `chore(board):` message, and returns the new SHA
- [ ] `push()` retries `pull --rebase` up to 3 times on non-fast-forward
- [ ] After 3 failures it returns a typed conflict error naming the diverged files
- [ ] All tests run against real repos created by `git init` in a temp dir — **git is not mocked**
- [ ] `bun test` passes

#### US-8: `kanbanly setup`
**As an** agent, **I want** one command to wire a code repo to a board **so that** setup is not
manual.

**Acceptance Criteria:**
- [ ] Writes `.kanbanly.yml` with `remote` and (layout A) `board`
- [ ] Appends a pointer line to root `AGENTS.md` and `CLAUDE.md`, creating them if absent
- [ ] Appending twice does not duplicate the line
- [ ] Writes `.gitattributes` with `**/cards/*.md merge=kanbanly`
- [ ] Runs `git config merge.kanbanly.driver` in the boards clone
- [ ] Scaffolds a starter `board.yml` and empty `cards/` when the repo is new
- [ ] `bun test` passes

#### US-9: Boards-repo `AGENTS.md` content
**As an** agent, **I want** the conventions in the repo **so that** I work correctly with
nothing installed.

**Acceptance Criteria:**
- [ ] Documents the card schema with a complete worked example
- [ ] States the ID generation procedure as executable steps
- [ ] States the order rule: read column, take max `order`, mint after — never insert between
- [ ] Gives before/after examples of a good Status rewrite and a good Log append
- [ ] Documents column transitions (Doing on start, Review on PR, Done on finish)
- [ ] Documents the re-read-before-write rule for shared checkouts
- [ ] Skill conformance test: a real agent produces schema-valid cards from this file alone

#### US-10: `kanbanly skill install`
**As a** user, **I want** one command to install the skill **so that** `/kanbanly setup` is
discoverable.

**Acceptance Criteria:**
- [ ] Detects `~/.claude/skills/`, `~/.codex/skills/`, and other known harness dirs
- [ ] Writes the bundled skill to each found directory; skips and reports missing ones
- [ ] `--path` flag targets an arbitrary directory
- [ ] Re-running overwrites cleanly and is idempotent
- [ ] `bun test` passes

### Phase 2 — Read

#### US-11: Connect wizard
**As a** user, **I want** to connect a boards repo from the UI **so that** first run isn't a
docs lookup.

**Acceptance Criteria:**
- [ ] Empty state prompts for a boards repo URL
- [ ] Credential is optional; SSH-agent and PAT paths both work
- [ ] Successful clone renders the board; failure shows a specific error, not a stack trace
- [ ] A repo with no `board.yml` offers to scaffold a starter board
- [ ] Verified in a browser against a real remote

#### US-12: Board render
**As a** user, **I want** to see my board **so that** I know the state of the work.

**Acceptance Criteria:**
- [ ] Columns render from `board.yml` in defined order with per-column counts
- [ ] Cards render sorted by `order`, tiebroken by id
- [ ] Card shows title, labels, assignee, due date
- [ ] Empty column renders an empty state, not a collapsed div
- [ ] `bun run typecheck`, `bun run lint`, `bun run build` all pass

#### US-13: SHA-keyed in-memory index
**As a** user, **I want** fast board loads **so that** navigation feels instant.

**Acceptance Criteria:**
- [ ] Index stores `{ sha, boards, cards }` per connected remote
- [ ] A fetch returning an unchanged SHA performs zero parsing (assert via a parse-call counter)
- [ ] A new SHA triggers a full re-parse of that remote only
- [ ] Benchmark: 2,000 cards re-index in under 500ms
- [ ] Benchmark: board render from index in under 100ms

#### US-14: Poll + SSE live updates
**As a** user, **I want** the board to update when an agent pushes **so that** I don't refresh.

**Acceptance Criteria:**
- [ ] Server fetches on a configurable interval, default 15s
- [ ] A SHA change pushes an update over SSE to all connected browsers
- [ ] The board updates without a full page reload
- [ ] Disconnect and reconnect resumes updates
- [ ] Verified end-to-end: push from a second clone, observe the board move

#### US-15: Navigation and URLs
**As a** user, **I want** to switch boards **so that** I can manage several projects.

**Acceptance Criteria:**
- [ ] Sidebar lists connected boards repos, expanding to their boards
- [ ] `/r/<remote-slug>/b/<board>` deep-links to a board
- [ ] `/r/<remote-slug>/b/<board>/<cardid>` deep-links to a card with the panel open
- [ ] Browser back/forward work correctly
- [ ] An unknown board or card id renders a not-found state

#### US-16: Card detail panel (read)
**As a** user, **I want** to read a card's full narrative **so that** I understand the work.

**Acceptance Criteria:**
- [ ] Clicking a card opens a side panel; the board stays visible
- [ ] Panel shows title, labels, assignee, due date, `## Status`, and `## Log`
- [ ] Markdown in Status and Log renders (lists, code, links)
- [ ] Escape and a close button both dismiss the panel

### Phase 3 — Write

#### US-17: Drag and drop
**As a** user, **I want** Trello-style drag and drop **so that** reordering is natural.

**Acceptance Criteria:**
- [ ] Dragging between columns updates `column` and mints a new `order`
- [ ] Dragging within a column mints an `order` between the neighbours
- [ ] A drop indicator shows the landing position
- [ ] Auto-scroll works when dragging near a column edge
- [ ] Playwright test performs a real drag and asserts the card lands in the target column
- [ ] `bun run test:e2e` passes

#### US-18: Move-card server function
**As a** user, **I want** my drag persisted **so that** it survives a reload.

**Acceptance Criteria:**
- [ ] Server function writes the card file and commits
- [ ] `updated` is set to the commit time
- [ ] A Log line is appended attributing the move to the human
- [ ] The optimistic UI update reconciles with the server response
- [ ] Playwright test asserts the commit exists in the repo after the drag

#### US-19: Background push queue
**As a** user, **I want** drags to feel instant **so that** the board isn't gated on the network.

**Acceptance Criteria:**
- [ ] Card settles in the UI at 0ms (optimistic)
- [ ] Local commit completes before the server function returns
- [ ] Pushes queue with a ~2s debounce; rapid drags coalesce into fewer pushes
- [ ] Header shows `● N changes syncing…`, `✓ synced`, `⚠ push failed — retry`
- [ ] Retry from the banner re-attempts the push
- [ ] Queue persists to `queue.json` and survives a server restart

#### US-20: Quick-add card
**As a** user, **I want** to capture an idea fast **so that** I don't lose it.

**Acceptance Criteria:**
- [ ] `+ Add card` on each column accepts a title and commits on Enter
- [ ] Created card has a generated id, correct `column`, `order` after the last, and
      `## Status: _Not started._`
- [ ] A Log line attributes creation to the human with today's date
- [ ] Escape cancels without creating anything
- [ ] The new card appears in the column immediately

#### US-21: Card detail editing
**As a** user, **I want** to fix card fields **so that** I'm not blocked on an agent.

**Acceptance Criteria:**
- [ ] Labels, assignee, and due date render as form controls that write frontmatter
- [ ] `## Status` is editable inline and overwrites on save
- [ ] `## Log` is read-only in the UI
- [ ] Each save commits once and bumps `updated`
- [ ] Concurrent edit from another clone resolves through the merge driver without data loss

#### US-22: Archive done cards
**As a** user, **I want** to clear finished work **so that** the Done column stays readable.

**Acceptance Criteria:**
- [ ] Done column renders the 20 most recent cards
- [ ] `[ Archive N older cards ]` appears when more than 20 exist
- [ ] Archiving `git mv`s files into `cards/archive/` in a single commit
- [ ] Archived cards are excluded from the index and the board
- [ ] `git log --follow` on an archived card shows its full history

### Phase 4 — Harden & Overlay

#### US-23: Credential error handling
**Acceptance Criteria:**
- [ ] An invalid or expired credential shows a banner naming the problem
- [ ] A missing scope names the specific scope required
- [ ] The banner offers a re-enter flow that retries the failed operation
- [ ] Test drives a real 401 and a real 403 from the remote

#### US-24: Offline queue
**Acceptance Criteria:**
- [ ] With the remote unreachable, drags and edits still commit locally
- [ ] Header shows `offline — N changes pending`
- [ ] The queue drains automatically on reconnect
- [ ] Test kills network mid-drag and asserts no data loss

#### US-25: Malformed frontmatter quarantine
**Acceptance Criteria:**
- [ ] A card with broken YAML renders in a quarantine lane showing the parse error
- [ ] The rest of the board renders normally
- [ ] The broken card's file path is shown so the user can fix it
- [ ] Fixing the file and pushing removes it from quarantine on the next fetch

#### US-26: Unknown column remap
**Acceptance Criteria:**
- [ ] Cards referencing a column id absent from `board.yml` render in
      `⚠ Unknown column: <id> (N)`
- [ ] A "move all to →" picker lists real columns
- [ ] Confirming rewrites all affected cards in one commit
- [ ] Nothing moves without explicit confirmation

#### US-27: Conflict resolution UI
**Acceptance Criteria:**
- [ ] After 3 failed rebase-and-push attempts, that repo's sync freezes
- [ ] Diverged cards are listed with both sides shown
- [ ] Keep-mine / keep-theirs resolves and resumes syncing
- [ ] Test drives a genuine unresolvable conflict between two clones

#### US-28: PR overlay
**Acceptance Criteria:**
- [ ] A card with `pr:` shows the PR number and state
- [ ] An open PR renders the pending target column (`⇒ lands REVIEW`)
- [ ] A merged PR clears the pending marker on the next fetch
- [ ] Missing GitHub credentials hide the overlay rather than erroring
- [ ] PR state is polled, not fetched per render

#### US-29: Filter bar
**Acceptance Criteria:**
- [ ] Filter by label, assignee, and free-text across title and Status
- [ ] Filters combine (AND across types, OR within a type)
- [ ] Filtering runs client-side against the in-memory index — no refetch
- [ ] Column counts reflect the filtered set
- [ ] Clearing filters restores the full board

#### US-30: Keyboard navigation
**Acceptance Criteria:**
- [ ] Arrow keys move focus between cards and columns
- [ ] Enter opens the focused card
- [ ] A documented shortcut moves the focused card between columns
- [ ] All interactive elements are reachable by Tab with a visible focus ring
- [ ] Verified with a screen reader for card and column announcements

#### US-31: Board activity feed
**Acceptance Criteria:**
- [ ] Reverse-chronological roll-up of every card's `## Log`
- [ ] Each entry links to its card
- [ ] Entries show date, author, and text
- [ ] Feed is derived from the existing index — no extra parsing pass

#### US-32: Theme switch
**Acceptance Criteria:**
- [ ] A switch offers Light / Dark / System
- [ ] System follows `prefers-color-scheme` and updates live when the OS changes
- [ ] The choice persists across reloads
- [ ] No flash of the wrong theme on load
- [ ] Both themes meet WCAG AA contrast on cards, labels, and the quarantine lane

---

## 8. Implementation Phases

### Phase 1: Format & Skill (`@kanbanly/core`, no server)
Card schema, board schema, id + order-key rules, merge driver, conflict healing, git storage
adapter, `kanbanly setup`, boards-repo `AGENTS.md`, `kanbanly skill install`.

**Rationale:** the file format is the contract everything depends on and can be fully specified
and tested with zero server code. An agent can be producing real cards before the UI exists.

**Verification:**
```bash
bun test                    # unit + merge fixtures + temp-repo integration
bun run typecheck
bun run lint
bun test:conformance        # real agent against a fixture boards repo
```

### Phase 2: Read
Connect wizard, clone, parse, board render, SHA-keyed index, poll + SSE, navigation, card
detail panel (read-only).

**Verification:**
```bash
bun test
bun run typecheck && bun run lint && bun run build
bun test:bench              # 2000 cards: re-index <500ms, render <100ms
```
Manual: connect a real boards repo, confirm the board renders and updates on external push.

### Phase 3: Write
Drag and drop, move-card server function, background push queue, quick-add, card detail
editing, archive.

**Verification:**
```bash
bun test
bun run test:e2e            # Playwright drag; assert card lands AND commit exists
bun run typecheck && bun run lint && bun run build
```

### Phase 4: Harden & Overlay
Five error states, rebase-retry, conflict UI, `pr:` overlay, filter bar, keyboard navigation,
activity feed, theme switch.

**Verification:**
```bash
bun test
bun run test:e2e
bun run typecheck && bun run lint && bun run build
```
Manual: kill network mid-drag; expire a credential; open a PR and observe pending state;
toggle theme in both directions.

---

## 9. Definition of Done

- [ ] All acceptance criteria in US-1 through US-32 pass
- [ ] All four implementation phases verified
- [ ] `bun test` passes
- [ ] `bun run test:e2e` passes
- [ ] `bun run typecheck` passes
- [ ] `bun run lint` passes
- [ ] `bun run build` succeeds
- [ ] Docker image builds and runs; `bunx kanbanly` works from a clean install
- [ ] Both light and dark themes verified against WCAG AA

---

## 10. Open Concerns for Implementation

1. **The frontmatter merge driver is the highest-risk component.** Plain `merge=union` on YAML
   produces duplicate keys that parsers silently resolve to the last one — silent data loss.
   The fixture table in US-5 is the guard; write it before the driver.
2. **Git's merge-driver security model means `.gitattributes` alone is not enough.** The driver
   command must be installed per-clone via `git config`. The conflict-healing fallback (US-6) is
   not optional — it's the only thing protecting clones that never ran setup.
3. **Pragmatic drag-and-drop uses native HTML5 drag events**, which are notoriously fiddly to
   drive in Playwright. Pin the e2e drag test down early; don't leave it to Phase 4.
4. **Bun is the runtime but `npx` users land on Node.** Both need testing per release, or the
   npm path silently breaks.
5. **OSS has no authentication, by explicit decision.** The server holds a credential with push
   access to connected repos. The `127.0.0.1` default and the `--host` warning are the only
   mitigations; do not weaken either.
6. **Agents sharing a checkout can race on a card file.** Documented as a known limit with a
   re-read-before-write convention. No lock files unless it actually bites someone.
7. **`@kanbanly/core` is the AGPL boundary.** Anything the closed SaaS repo needs must live
   there and be publishable; anything SaaS-specific must not leak into it.

---

## 11. Ralph Loop Command

```bash
/ralph-loop "Implement kanbanly per spec at docs/specs/i-want-to-create-a-kanban-board-that-can-host-multiple-separ.md

PHASES:
1. Format & Skill: @kanbanly/core — card + board Zod schemas, id generation, fractional order keys, merge driver, conflict-marker healing, git storage adapter, kanbanly setup, boards-repo AGENTS.md, kanbanly skill install (US-1..US-10) - verify with 'bun test && bun run typecheck && bun run lint'
2. Read: connect wizard, clone, board render, SHA-keyed in-memory index, poll + SSE, navigation and URLs, card detail panel read-only (US-11..US-16) - verify with 'bun test && bun run build && bun test:bench'
3. Write: Pragmatic drag-and-drop, move-card server function, background push queue, quick-add, card detail editing, archive (US-17..US-22) - verify with 'bun test && bun run test:e2e'
4. Harden & Overlay: five error states, rebase-retry, conflict UI, pr: overlay, filter bar, keyboard navigation, activity feed, theme switch (US-23..US-32) - verify with 'bun test && bun run test:e2e && bun run build'

VERIFICATION (run after each phase):
- bun test
- bun run typecheck
- bun run lint
- bun run build

CRITICAL CONSTRAINTS:
- Never use plain 'merge=union' on YAML frontmatter — it produces duplicate keys that parse to the last value. Write the merge fixture table before the driver.
- Test the git layer against real repos via 'git init' in a temp dir. Do not mock git.
- The conflict-marker healing fallback is required, not optional — git will not let a repo define what a merge driver executes.

ESCAPE HATCH: After 20 iterations without progress:
- Document what's blocking in the spec file under 'Implementation Notes'
- List approaches attempted
- Stop and ask for human guidance

Output <promise>COMPLETE</promise> when all phases pass verification." --max-iterations 30 --completion-promise "COMPLETE"
```

---

## 12. Decision Log

Two major revisions occurred during the interview. Superseded decisions are recorded so the
reasoning isn't lost.

| Was | Now | Why |
|---|---|---|
| Board content at `.kanbanly/` inside the code repo | Boards in their own repo(s); code repo holds `.kanbanly.yml` | User redirect |
| Card changes ride the feature branch, land on merge | Boards live on their default branch | Follows from above |
| Card status visible in the PR diff | Gone | Follows from above |
| Ghost overlay computed by `git diff main..branch` | Overlay from a declared `pr:` link + forge API | No branch copies to diff |
| Conventions in `.kanbunny/AGENTS.md` per code repo | One `AGENTS.md` at the boards repo root | DRY |
| First run pastes a GitHub PAT and picks a repo | First run takes a boards repo URL; credentials optional | Any git remote works |
| SaaS clones customer repos | SaaS stores boards in S3 with ETag CAS | User redirect |
| Single Go binary shelling out to git | All TypeScript on Bun | Go's only benefit was the binary |
| TanStack Start in SPA mode | Full-stack Start with server functions | Node owns the API now |
| npm wrapper package around a Go binary | Native npm package | No binary to wrap |
| GoReleaser, cross-compiled binaries, checksums | Docker + npm only | User: "only docker/npm in oss" |
| `bun build --compile` standalone binary | Dropped | Same |
| Closed repo consuming a Go core library | Closed repo importing `@kanbanly/core` from npm | Same boundary, less friction |
| SaaS = two services (Go core + Node AI) | One TypeScript app | No language boundary |
| Priority-only card sort | Fractional-index drag-and-drop | User: "drag and drop like real kanban" |
| AI assistant available in OSS with BYO key | SaaS-only | User decision |
| Playful bunny mascot | Clean, calm identity, no mascot | Rename to kanbanly |
| Named kanbunny | Named kanbanly | User rename |
