#!/usr/bin/env bash
# Live launch acceptance for @kanbanly/server (OSS multi-board).
# Seeds fixtures/boards-layout-a into a temp git repo, boots shipped CLI,
# asserts /api/boards/backend + HTML / bodies, create+move via API, git log.
#
# Usage:
#   scripts/oss-live-launch.sh [run-label]
#   RUN_LABEL=run1 LOG=/path/to/oss-launch.log scripts/oss-live-launch.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FIXTURE="$ROOT/fixtures/boards-layout-a"
CLI="$ROOT/packages/server/src/cli.ts"
SCRATCH="${SCRATCH:-/var/folders/6g/0mgw03w94r54hqkzyw46zc8r0000gn/T/grok-goal-45a9283bd779/implementer}"
RUN_LABEL="${1:-${RUN_LABEL:-run1}}"
if [[ "$RUN_LABEL" == "run2" || "$RUN_LABEL" == "2" ]]; then
  LOG="${LOG:-$SCRATCH/oss-launch-run2.log}"
else
  LOG="${LOG:-$SCRATCH/oss-launch.log}"
fi

mkdir -p "$SCRATCH"
WORKDIR="$(mktemp -d "$SCRATCH/launch-XXXXXX")"
REPO="$WORKDIR/boards"
SERVER_PID=""
SERVER_OUT="$WORKDIR/server.stdout"

cleanup() {
  if [[ -n "${SERVER_PID:-}" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

log() { printf '%s\n' "$*" | tee -a "$LOG"; }

: >"$LOG"
log "=== OSS launch $RUN_LABEL $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
log "ROOT=$ROOT"
log "REPO=$REPO"
log "CLI=$CLI"

# --- seed temp git repo from layout A fixture ---
mkdir -p "$REPO"
cp -R "$FIXTURE"/. "$REPO/"
git -C "$REPO" init -q
git -C "$REPO" config user.name "kanbanly-launch"
git -C "$REPO" config user.email "kanbanly-launch@local"
git -C "$REPO" checkout -q -b main 2>/dev/null || git -C "$REPO" checkout -q main
git -C "$REPO" add .
git -C "$REPO" commit -q -m "init launch fixture"
log "seeded git repo @ $(git -C "$REPO" rev-parse HEAD)"

# --- free port ---
PORT="$(bun -e 'const s=Bun.serve({hostname:"127.0.0.1",port:0,fetch:()=>new Response("ok")});const p=s.port;s.stop(true);console.log(p)')"
log "port=$PORT"

# --- boot shipped CLI ---
bun run "$CLI" serve --host 127.0.0.1 --port "$PORT" --repo "$REPO" >"$SERVER_OUT" 2>&1 &
SERVER_PID=$!
log "pid=$SERVER_PID"

# wait for health
ok=0
for i in $(seq 1 40); do
  if curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
    ok=1
    log "health ok attempt=$i"
    break
  fi
  sleep 0.15
done
if [[ "$ok" -ne 1 ]]; then
  log "FAIL: server never became healthy"
  log "--- server stdout ---"
  cat "$SERVER_OUT" | tee -a "$LOG"
  exit 1
fi

BASE="http://127.0.0.1:$PORT"
FAIL=0

# --- /health ---
log "--- /health ---"
HEALTH="$(curl -sf "$BASE/health")"
log "$HEALTH"
echo "$HEALTH" | grep -q '"ok":true' || { log "ASSERT_FAIL health"; FAIL=1; }

# --- /api/boards multi-board ---
log "--- /api/boards ---"
BOARDS="$(curl -sf "$BASE/api/boards")"
log "$BOARDS"
echo "$BOARDS" | grep -q '"id":"backend"' || { log "ASSERT_FAIL multi-board backend"; FAIL=1; }
echo "$BOARDS" | grep -q '"id":"web"' || { log "ASSERT_FAIL multi-board web"; FAIL=1; }

# --- /api/boards/backend body has columns + cards ---
log "--- /api/boards/backend ---"
BACKEND="$(curl -sf "$BASE/api/boards/backend")"
# keep log readable but full enough for audit
log "$BACKEND"
echo "$BACKEND" | grep -q '"id":"backend"' || { log "ASSERT_FAIL backend id"; FAIL=1; }
echo "$BACKEND" | grep -q '"id":"backlog"' || { log "ASSERT_FAIL columns"; FAIL=1; }
echo "$BACKEND" | grep -q 'Setup auth middleware' || { log "ASSERT_FAIL card title in body"; FAIL=1; }
echo "$BACKEND" | grep -q 'c-a1b2' || { log "ASSERT_FAIL card id in body"; FAIL=1; }
echo "$BACKEND" | grep -q 'Wire up rate limiter' || { log "ASSERT_FAIL second card"; FAIL=1; }
if [[ $FAIL -eq 0 ]]; then log "ASSERT_OK body has board/card data for /api/boards/backend"; fi

# --- HTML / body has board + card data ---
log "--- GET / HTML ---"
HTML="$(curl -sf "$BASE/")"
# store full HTML in log (may be long)
log "$HTML"
echo "$HTML" | grep -q 'Board: backend' || { log "ASSERT_FAIL html board"; FAIL=1; }
echo "$HTML" | grep -q 'Setup auth middleware' || { log "ASSERT_FAIL html card title"; FAIL=1; }
echo "$HTML" | grep -q 'c-a1b2' || { log "ASSERT_FAIL html card id"; FAIL=1; }
echo "$HTML" | grep -q 'data-board-id="backend"' || { log "ASSERT_FAIL html data-board-id"; FAIL=1; }
if [[ $FAIL -eq 0 ]]; then log "ASSERT_OK html board content"; fi

# --- create title-only card via API ---
log "--- create ---"
CREATE="$(curl -sf -X POST "$BASE/api/boards/backend/cards" \
  -H 'content-type: application/json' \
  -d '{"title":"Live path card","column":"backlog"}')"
log "$CREATE"
CARD_ID="$(echo "$CREATE" | bun -e 'const j=JSON.parse(await Bun.stdin.text()); if(!j.ok||!j.card?.id) process.exit(2); process.stdout.write(j.card.id)')" \
  || { log "ASSERT_FAIL create parse"; FAIL=1; CARD_ID=""; }
log "card_id=$CARD_ID"
echo "$CREATE" | grep -q '"ok":true' || { log "ASSERT_FAIL create ok"; FAIL=1; }
echo "$CREATE" | grep -q 'Live path card' || { log "ASSERT_FAIL create title"; FAIL=1; }

# --- move card via API ---
log "--- move ---"
MOVE="$(curl -sf -X POST "$BASE/api/boards/backend/cards/${CARD_ID}/move" \
  -H 'content-type: application/json' \
  -d '{"column":"doing"}')"
log "$MOVE"
echo "$MOVE" | grep -q '"ok":true' || { log "ASSERT_FAIL move ok"; FAIL=1; }
echo "$MOVE" | grep -q '"column":"doing"' || { log "ASSERT_FAIL move column"; FAIL=1; }

# --- filesystem card exists ---
CARD_FILE="$(find "$REPO/backend/cards" -name "${CARD_ID}-*.md" | head -1)"
log "card_file=$CARD_FILE"
if [[ -n "$CARD_FILE" && -f "$CARD_FILE" ]]; then
  log "ASSERT_OK card file on disk"
  # column should now be doing after move
  if grep -q 'column: doing' "$CARD_FILE"; then
    log "ASSERT_OK card markdown column=doing"
  else
    log "ASSERT_FAIL card markdown column not doing"
    FAIL=1
  fi
else
  log "ASSERT_FAIL card file missing"
  FAIL=1
fi

# --- git log has create + move commits ---
log "--- git log ---"
GLOG="$(git -C "$REPO" log --oneline)"
log "$GLOG"
echo "$GLOG" | grep -q "create $CARD_ID" || echo "$GLOG" | grep -qi create || { log "ASSERT_FAIL git create commit"; FAIL=1; }
echo "$GLOG" | grep -q "move $CARD_ID" || echo "$GLOG" | grep -qi move || { log "ASSERT_FAIL git move commit"; FAIL=1; }
if echo "$GLOG" | grep -q "chore(board): create" && echo "$GLOG" | grep -q "chore(board): move"; then
  log "ASSERT_OK git commits"
else
  # still accept if create/move wording present
  if echo "$GLOG" | grep -qi create && echo "$GLOG" | grep -qi move; then
    log "ASSERT_OK git commits (loose match)"
  else
    log "ASSERT_FAIL git commits missing"
    FAIL=1
  fi
fi

# --- server stdout transcript ---
log "--- server stdout ---"
cat "$SERVER_OUT" | tee -a "$LOG" || true

if [[ $FAIL -ne 0 ]]; then
  log "=== FAIL $RUN_LABEL ==="
  exit 1
fi
log "=== end $RUN_LABEL OK ==="
exit 0
