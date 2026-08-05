#!/bin/sh
# Default OSS posture: serve the board UI with a boards git repo at $KANBANLY_REPO.
set -eu

REPO="${KANBANLY_REPO:-/boards}"
HOST="${KANBANLY_HOST:-0.0.0.0}"
PORT="${KANBANLY_PORT:-3847}"
DEMO_SRC="${KANBANLY_DEMO_SRC:-/opt/kanbanly/demo-boards}"

ensure_boards_repo() {
  mkdir -p "$REPO"

  # Seed demo layout when the mount is empty
  if [ -z "$(ls -A "$REPO" 2>/dev/null || true)" ]; then
    if [ -d "$DEMO_SRC" ] && [ -n "$(ls -A "$DEMO_SRC" 2>/dev/null || true)" ]; then
      echo "kanbanly: seeding demo boards into $REPO"
      cp -a "$DEMO_SRC"/. "$REPO"/
    fi
  fi

  if [ ! -d "$REPO/.git" ]; then
    echo "kanbanly: initializing git repository at $REPO"
    git -C "$REPO" init
    git -C "$REPO" config user.name "kanbanly"
    git -C "$REPO" config user.email "kanbanly@local"
    # Prefer main as default branch
    git -C "$REPO" checkout -b main 2>/dev/null || true
    git -C "$REPO" add -A
    git -C "$REPO" -c user.name=kanbanly -c user.email=kanbanly@local \
      commit -m "chore(board): initialize boards repo" --allow-empty || true
  fi
}

args_have_repo() {
  for a in "$@"; do
    case "$a" in
      --repo|--repo=*) return 0 ;;
    esac
  done
  return 1
}

args_have_host() {
  for a in "$@"; do
    case "$a" in
      --host|--host=*) return 0 ;;
    esac
  done
  return 1
}

args_have_port() {
  for a in "$@"; do
    case "$a" in
      --port|--port=*) return 0 ;;
    esac
  done
  return 1
}

# No args → default serve
if [ "$#" -eq 0 ]; then
  set -- serve
fi

# Default serve posture: always ensure a boards repo when serving
if [ "$1" = "serve" ]; then
  ensure_boards_repo
  shift
  extra=""
  if ! args_have_host "$@"; then
    set -- --host "$HOST" "$@"
  fi
  if ! args_have_port "$@"; then
    set -- --port "$PORT" "$@"
  fi
  if ! args_have_repo "$@"; then
    set -- --repo "$REPO" "$@"
  fi
  set -- serve "$@"
fi

echo "kanbanly: $(printf '%s ' "$@")"
exec bun run /app/packages/server/src/cli.ts "$@"
