# Testing kanbanly

Layered verification so you can go from “unit green” to “real PAT + remote green” without guessing.

## 1. Offline (no secrets, always)

```bash
bun install
bun test packages/core packages/server
bun run test:remote-roundtrip   # bare-git push/pull/create/move parity
bun run test:closeout           # typecheck + lint + tests + e2e + build
```

| Suite | What it proves |
|-------|----------------|
| `packages/core` | Card/board parse, long IDs, merge, credentials crypto |
| `packages/server` | HTTP API, connect wizard, push queue, multi-remote |
| `remote-roundtrip.test.ts` | **Full cycle**: create board/cards → push bare origin → second clone sees same data |
| `test:e2e` | Drop/move → git commit (Playwright optional) |

Bare remotes use local `git init --bare` — same code paths as GitHub HTTPS, without network.

## 2. Live Docker smoke (your demo UI)

Server at **http://127.0.0.1:22000/** (compose default):

```bash
docker compose -f deploy/compose.yaml up --build -d
KANBANLY_BASE_URL=http://127.0.0.1:22000 bun run test:remote-roundtrip -- --live
```

Creates a timestamped card on the first board and reports sync status.

### Fleet digest (unattended multi-project)

```bash
# Against a local boards clone
bun run kanbanly -- fleet-digest --repo /path/to/boards

# Against the running server
curl -sf "http://127.0.0.1:22000/api/fleet-health?format=text"

# Cron: alert only when high severity
# */30 * * * * kanbanly fleet-digest --repo /boards --only-issues --fail-on-high --webhook "$SLACK_WEBHOOK"
```

## 3. Real remote + PAT (you configure secrets)

**Never paste a PAT into chat or commit it.**

### A. Create remote

1. Empty private repo on GitHub/GitLab (no README if you want a clean first push).
2. Fine-grained PAT: **Contents Read and write** on that repo  
   (classic: `repo` scope).

### B. Wire credentials into OSS

**UI (easiest)**

1. Open http://127.0.0.1:22000/ → **Settings → Credentials** → add PAT label + token  
2. **Settings → Repositories** → connect HTTPS URL (or push-set origin on the boards volume)  
3. Click the header sync badge to push

**API**

```bash
export KANBANLY_BASE_URL=http://127.0.0.1:22000
export GITHUB_PAT=ghp_…   # shell only

curl -sf -X POST "$KANBANLY_BASE_URL/api/connect" \
  -H 'content-type: application/json' \
  -d "{\"url\":\"https://github.com/YOU/boards.git\",\"token\":\"$GITHUB_PAT\"}"
```

**Docker note:** credentials and workspace live under `~/.kanbanly` **inside** the container unless mounted. Compose mounts:

```yaml
- ${HOME}/.kanbanly:/root/.kanbanly
```

so PATs and multi-remote config survive restarts.

### C. Prove push

```bash
# write something
curl -sf -X POST "$KANBANLY_BASE_URL/api/boards/<boardId>/cards" \
  -H 'content-type: application/json' \
  -d '{"title":"PAT round-trip","column":"backlog"}'

# drain push queue
curl -sf -X POST "$KANBANLY_BASE_URL/api/sync/retry"
curl -sf "$KANBANLY_BASE_URL/api/sync"   # expect status: synced

# clone elsewhere and list cards/
git clone https://github.com/YOU/boards.git /tmp/boards-check
ls /tmp/boards-check/*/cards
```

### D. Tell the agent “run the suite”

Once the remote is connected and a push succeeds once:

```bash
bun test packages/core packages/server
bun run test:remote-roundtrip -- --live
```

Optional GitHub flag only prints safe connect reminders (does not echo the PAT):

```bash
KANBANLY_TEST_REMOTE=https://github.com/YOU/boards.git \
KANBANLY_TEST_PAT="$GITHUB_PAT" \
bun run test:remote-roundtrip -- --github
```

## 4. Agent skill

Canonical skill lives in the monorepo:

- [`skills/kanbanly/SKILL.md`](../skills/kanbanly/SKILL.md)

Install into harness dirs (`~/.claude/skills`, `~/.agents/skills`, `~/.codex/skills`):

```bash
bun run kanbanly -- skill-install
# or explicit:
bun run kanbanly -- skill-install --path ~/.agents/skills
```

Symlink from this repo (optional, for local agent discovery):

```bash
mkdir -p .agents/skills
ln -sfn ../../skills/kanbanly .agents/skills/kanbanly
```

## 5. Recommended order for a human “first green remote”

1. `bun run test:remote-roundtrip` — offline bare green  
2. Docker up + demo boards look good in UI  
3. Add PAT + empty private repo in Settings  
4. Header sync → `synced`  
5. `KANBANLY_BASE_URL=… bun run test:remote-roundtrip -- --live`  
6. Second machine / second clone sees the same cards  
7. `bun run kanbanly -- skill-install` so agents know the card contract  

That is a full product round-trip: **UI + API + git push + second consumer + agent skill**.
