#!/usr/bin/env bun
/**
 * kanbanly CLI — OSS server entry.
 *
 *   kanbanly serve [--host 127.0.0.1] [--port 3847] [--repo <path>]
 *   kanbanly merge-driver %O %A %B
 *   kanbanly setup --code <path> --boards <path> --remote <url> [--board <id>]
 *   kanbanly skill-install [--path <dir>]
 *   kanbanly session-end --repo <path> --board <id> --card <id> --summary <text> [--agent <name>] [--status <text>] [--sha <short>]
 *   kanbanly session-start --repo <path> --board <id> [--agent <name>]
 *   kanbanly fleet-digest --repo <path> [--json] [--fail-on-high] [--only-issues] [--webhook <url>]
 */
import { resolve } from "node:path";
import {
  applySessionEnd,
  buildFleetHealth,
  buildSessionStartBrief,
  canAgentPickup,
  countCommitsInWindow,
  fleetWebhookPayload,
  formatFleetDigest,
  formatSessionStartBrief,
  kanbanlySetup,
  runMergeDriver,
  skillInstall,
  type PortfolioBoardInput,
} from "@kanbanly/core";
import { connectLocalRepo, type ConnectedRepo } from "./connect.ts";
import { startServer } from "./app.ts";

export const DEFAULT_HOST = process.env.KANBANLY_HOST?.trim() || "127.0.0.1";
export const DEFAULT_PORT = Number(process.env.KANBANLY_PORT) || 3847;

export const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

function printUsage(): void {
  console.log(`kanbanly — Kanban for ADHD

Default OSS posture is Docker:
  docker compose -f deploy/compose.yaml up --build
  → http://127.0.0.1:3847/

Usage:
  kanbanly serve [--host 127.0.0.1] [--port 3847] [--repo <path>]
  kanbanly merge-driver <ancestor> <ours> <theirs>
  kanbanly setup --code <path> --boards <path> --remote <url> [--board <id>]
  kanbanly skill-install [--path <dir>]
  kanbanly session-end --repo <boards> --board <id> --card <id> --summary <text>
                       [--agent <name>] [--status <text>] [--sha <short>]
  kanbanly session-start --repo <boards> --board <id> [--agent <name>]
  kanbanly fleet-digest --repo <boards> [--json] [--fail-on-high] [--only-issues]
                        [--webhook <url>]

Options:
  --host   Bind address (default: $KANBANLY_HOST or 127.0.0.1). Non-loopback warns.
  --port   Port (default: $KANBANLY_PORT or 3847)
  --repo   Path to a boards git repository (default: $KANBANLY_REPO if set)
  --code   Code repo root for setup (writes .kanbanly.yml)
  --boards Boards repo path for setup
  --remote Boards remote URL for setup
  --board  Layout A board id when scaffolding (default: backend)
  --path   Target directory for skill-install
  --card   Card id for session-end
  --summary  Session-end summary line (required for session-end)
  --agent  Actor name for Log (default: agent)
  --status Optional ## Status overwrite on session-end
  --sha    Optional short code commit SHA to include in Log
  --json   fleet-digest: print JSON instead of text
  --fail-on-high  fleet-digest: exit 1 when high-severity issues exist
  --only-issues   fleet-digest: print/post only when not ok (silence healthy fleets)
  --webhook  fleet-digest: POST Slack-compatible payload to URL
  -h, --help  Show this help

Environment:
  KANBANLY_HOST   Default bind host
  KANBANLY_PORT   Default port
  KANBANLY_REPO   Default --repo path (used by Docker entrypoint as /boards)

Fleet digest (cron / Slack):
  kanbanly fleet-digest --repo ~/boards --fail-on-high
  curl -sf "http://127.0.0.1:3847/api/fleet-health?format=text"
  # every 30m, only when broken, post to Slack:
  # */30 * * * * kanbanly fleet-digest --repo /boards --only-issues --webhook "$SLACK_URL" --fail-on-high
`);
}

/** Exported for tests — default host is loopback. */
export function parseArgs(argv: string[]): {
  command?: string;
  host: string;
  port: number;
  repo?: string;
  code?: string;
  boards?: string;
  remote?: string;
  board?: string;
  path?: string;
  card?: string;
  summary?: string;
  agent?: string;
  status?: string;
  sha?: string;
  webhook?: string;
  json: boolean;
  failOnHigh: boolean;
  onlyIssues: boolean;
  help: boolean;
  rest: string[];
} {
  const args = [...argv];
  // Drop node/bun and script path if present
  while (
    args[0] &&
    (args[0].endsWith("bun") ||
      args[0].endsWith("node") ||
      args[0].includes("cli.ts") ||
      args[0].includes("cli.js"))
  ) {
    args.shift();
  }

  let command: string | undefined;
  if (args[0] && !args[0].startsWith("-")) {
    command = args.shift();
  }

  let host = DEFAULT_HOST;
  let port = DEFAULT_PORT;
  let repo: string | undefined = process.env.KANBANLY_REPO?.trim() || undefined;
  let code: string | undefined;
  let boards: string | undefined;
  let remote: string | undefined;
  let board: string | undefined;
  let path: string | undefined;
  let card: string | undefined;
  let summary: string | undefined;
  let agent: string | undefined;
  let status: string | undefined;
  let sha: string | undefined;
  let webhook: string | undefined;
  let json = false;
  let failOnHigh = false;
  let onlyIssues = false;
  let help = false;
  const rest: string[] = [];

  const take = (i: number): string => {
    const v = args[i + 1];
    if (!v || v.startsWith("-")) return "";
    return v;
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "-h" || a === "--help") {
      help = true;
    } else if (a === "--host" && args[i + 1]) {
      host = args[++i]!;
    } else if (a.startsWith("--host=")) {
      host = a.slice("--host=".length);
    } else if (a === "--port" && args[i + 1]) {
      port = Number(args[++i]!);
    } else if (a.startsWith("--port=")) {
      port = Number(a.slice("--port=".length));
    } else if (a === "--repo" && args[i + 1]) {
      repo = args[++i]!;
    } else if (a.startsWith("--repo=")) {
      repo = a.slice("--repo=".length);
    } else if (a === "--code" && args[i + 1]) {
      code = args[++i]!;
    } else if (a.startsWith("--code=")) {
      code = a.slice("--code=".length);
    } else if (a === "--boards" && args[i + 1]) {
      boards = args[++i]!;
    } else if (a.startsWith("--boards=")) {
      boards = a.slice("--boards=".length);
    } else if (a === "--remote" && args[i + 1]) {
      remote = args[++i]!;
    } else if (a.startsWith("--remote=")) {
      remote = a.slice("--remote=".length);
    } else if (a === "--board" && args[i + 1]) {
      board = args[++i]!;
    } else if (a.startsWith("--board=")) {
      board = a.slice("--board=".length);
    } else if (a === "--path" && args[i + 1]) {
      path = args[++i]!;
    } else if (a.startsWith("--path=")) {
      path = a.slice("--path=".length);
    } else if (a === "--card" && take(i)) {
      card = args[++i]!;
    } else if (a.startsWith("--card=")) {
      card = a.slice("--card=".length);
    } else if (a === "--summary" && take(i)) {
      summary = args[++i]!;
    } else if (a.startsWith("--summary=")) {
      summary = a.slice("--summary=".length);
    } else if (a === "--agent" && take(i)) {
      agent = args[++i]!;
    } else if (a.startsWith("--agent=")) {
      agent = a.slice("--agent=".length);
    } else if (a === "--status" && take(i)) {
      status = args[++i]!;
    } else if (a.startsWith("--status=")) {
      status = a.slice("--status=".length);
    } else if (a === "--sha" && take(i)) {
      sha = args[++i]!;
    } else if (a.startsWith("--sha=")) {
      sha = a.slice("--sha=".length);
    } else if (a === "--webhook" && take(i)) {
      webhook = args[++i]!;
    } else if (a.startsWith("--webhook=")) {
      webhook = a.slice("--webhook=".length);
    } else if (a === "--json") {
      json = true;
    } else if (a === "--fail-on-high") {
      failOnHigh = true;
    } else if (a === "--only-issues") {
      onlyIssues = true;
    } else if (!a.startsWith("-")) {
      rest.push(a);
    }
  }

  return {
    command,
    host,
    port,
    repo,
    code,
    boards,
    remote,
    board,
    path,
    card,
    summary,
    agent,
    status,
    sha,
    webhook,
    json,
    failOnHigh,
    onlyIssues,
    help,
    rest,
  };
}

/** Load all boards into portfolio inputs (local CLI, no index store). */
export async function loadPortfolioInputs(
  connected: ConnectedRepo,
): Promise<PortfolioBoardInput[]> {
  const listed = await connected.storage.listBoards();
  if (!listed.ok) return [];
  const inputs: PortfolioBoardInput[] = [];
  for (const summary of listed.value) {
    const boardRead = await connected.storage.readBoard(summary.id);
    if (!boardRead.ok) continue;
    const cardsListed = await connected.storage.listCards(summary.id);
    const cards: PortfolioBoardInput["cards"] = [];
    if (cardsListed.ok) {
      for (const ref of cardsListed.value) {
        const c = await connected.storage.readCard(summary.id, ref.id);
        if (!c.ok) continue;
        cards.push({
          id: c.value.frontmatter.id,
          title: c.value.frontmatter.title,
          column: c.value.frontmatter.column,
          priority: c.value.frontmatter.priority,
          assignee: c.value.frontmatter.assignee,
          updated: c.value.frontmatter.updated,
          log: c.value.log ?? [],
        });
      }
    }
    let codeCommits7d: number | null = null;
    let codeCommits24h: number | null = null;
    const hist = connected.storage.codeHistory(summary.id, { limit: 100 });
    if (hist.ok && hist.value.bound) {
      codeCommits7d = countCommitsInWindow(hist.value.commits, 7);
      codeCommits24h = countCommitsInWindow(hist.value.commits, 1);
    }
    inputs.push({
      id: summary.id,
      title: boardRead.value.title?.trim() || summary.id,
      columns: boardRead.value.columns.map((c) => ({ id: c.id, name: c.name })),
      cards,
      settings: (boardRead.value.settings ?? {}) as Record<string, unknown>,
      codeCommits7d,
      codeCommits24h,
    });
  }
  return inputs;
}

/** Returns true if host is loopback (no warning needed). Exported for tests. */
export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host);
}

export function warnIfPublicBind(host: string): string | null {
  if (isLoopbackHost(host)) return null;
  const msg = `
!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
!!  WARNING: binding to ${host} (not loopback)                      !!
!!                                                                    !!
!!  Anyone who can reach this host can push commits to every          !!
!!  connected boards repository. There is NO authentication.          !!
!!                                                                    !!
!!  Prefer --host 127.0.0.1 unless you intentionally expose this.     !!
!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
`;
  console.error(msg);
  return msg;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const opts = parseArgs(argv);

  if (opts.help || !opts.command) {
    printUsage();
    if (!opts.command) process.exit(opts.help ? 0 : 1);
    return;
  }

  if (opts.command === "merge-driver") {
    const paths = opts.rest.length >= 3
      ? opts.rest
      : (() => {
          const rest = [...argv];
          const cmdIdx = rest.findIndex((a) => a === "merge-driver");
          return (cmdIdx >= 0 ? rest.slice(cmdIdx + 1) : rest).filter(
            (a) => !a.startsWith("-"),
          );
        })();
    const ancestor = paths[0];
    const ours = paths[1];
    const theirs = paths[2];
    if (!ancestor || !ours || !theirs) {
      console.error("Usage: kanbanly merge-driver <ancestor> <ours> <theirs>");
      process.exit(2);
    }
    await runMergeDriver(ancestor, ours, theirs);
    return;
  }

  if (opts.command === "setup") {
    if (!opts.code || !opts.boards || !opts.remote) {
      console.error(
        "Usage: kanbanly setup --code <path> --boards <path> --remote <url> [--board <id>]",
      );
      process.exit(2);
    }
    const result = kanbanlySetup({
      codeRepoPath: resolve(opts.code),
      boardsRepoPath: resolve(opts.boards),
      remote: opts.remote,
      board: opts.board ?? "backend",
    });
    console.log(`Wrote .kanbanly.yml and pointers under ${resolve(opts.code)}`);
    console.log(`Boards scaffold: ${resolve(opts.boards)}`);
    if (result.boardYml) console.log("Created starter board.yml");
    console.log(`gitattributes: merge=kanbanly for **/cards/*.md`);
    return;
  }

  if (opts.command === "skill-install") {
    const result = skillInstall({ path: opts.path ? resolve(opts.path) : undefined });
    for (const p of result.installed) console.log(`installed: ${p}`);
    for (const p of result.skipped) console.log(`skipped (missing): ${p}`);
    if (result.installed.length === 0) {
      console.error("No skill directories found. Pass --path <dir>.");
      process.exit(1);
    }
    return;
  }

  if (opts.command === "session-start") {
    const repoPath = opts.repo ? resolve(opts.repo) : undefined;
    const boardId = opts.board?.trim();
    if (!repoPath || !boardId) {
      console.error(
        "Usage: kanbanly session-start --repo <boards> --board <id> [--agent name]",
      );
      process.exit(2);
    }
    const connected = await connectLocalRepo(repoPath, { scaffold: false });
    const boardRead = await connected.storage.readBoard(boardId);
    if (!boardRead.ok) {
      console.error(`Board not found: ${boardId}`);
      process.exit(1);
    }
    const listed = await connected.storage.listCards(boardId);
    const cards: Array<{
      id: string;
      title: string;
      column: string;
      priority?: string;
      assignee?: string;
    }> = [];
    if (listed.ok) {
      for (const ref of listed.value) {
        const c = await connected.storage.readCard(boardId, ref.id);
        if (!c.ok) continue;
        cards.push({
          id: c.value.frontmatter.id,
          title: c.value.frontmatter.title,
          column: c.value.frontmatter.column,
          priority: c.value.frontmatter.priority,
          assignee: c.value.frontmatter.assignee,
        });
      }
    }
    const notes = connected.storage.readNotes(boardId);
    let commits: Array<{
      sha: string;
      date: string;
      author: string;
      subject: string;
    }> = [];
    const hist = connected.storage.codeHistory(boardId, { limit: 10 });
    if (hist.ok && hist.value.bound) {
      commits = hist.value.commits;
    }
    const brief = buildSessionStartBrief({
      boardId,
      boardTitle:
        boardRead.value.title?.trim() || boardId,
      notesBody: notes.ok ? notes.value.body : "",
      cards,
      commits,
      settings: boardRead.value.settings as Record<string, unknown>,
      actor: opts.agent?.trim() || "agent",
    });
    console.log(formatSessionStartBrief(brief));
    return;
  }

  if (opts.command === "session-end") {
    const repoPath = opts.repo ? resolve(opts.repo) : undefined;
    const boardId = opts.board?.trim();
    const cardId = opts.card?.trim();
    const summary = opts.summary?.trim();
    if (!repoPath || !boardId || !cardId || !summary) {
      console.error(
        "Usage: kanbanly session-end --repo <boards> --board <id> --card <id> --summary <text> [--agent name] [--status text] [--sha short]",
      );
      process.exit(2);
    }
    const connected = await connectLocalRepo(repoPath, { scaffold: false });
    const read = await connected.storage.readCard(boardId, cardId);
    if (!read.ok) {
      console.error(
        `Card not found: ${boardId}/${cardId} (${read.error.kind})`,
      );
      process.exit(1);
    }
    const actor = opts.agent?.trim() || "agent";
    const pickup = canAgentPickup(read.value, actor);
    if (!pickup.ok) {
      console.error(`Pickup warning: ${pickup.reason}`);
      // Still allow session-end (work may finish from Review etc.)
    }
    const ended = applySessionEnd({
      card: read.value,
      summary,
      actor,
      status: opts.status,
      sha: opts.sha,
    });
    // Prefer Doing when ending if still on Ready
    if (ended.card.frontmatter.column === "ready") {
      ended.card.frontmatter.column = "doing";
    }
    const w = await connected.storage.writeCard(boardId, ended.card, {
      message: `chore(board): session-end ${cardId}`,
    });
    if (!w.ok) {
      console.error(`Write failed: ${w.error.kind} ${w.error.message ?? ""}`);
      process.exit(1);
    }
    console.log(`session-end ok card=${cardId} board=${boardId}`);
    console.log(`log: ${ended.logLine}`);
    if (w.value.sha) console.log(`sha: ${w.value.sha}`);
    return;
  }

  if (opts.command === "fleet-digest") {
    const repoPath = opts.repo ? resolve(opts.repo) : undefined;
    if (!repoPath) {
      console.error(
        "Usage: kanbanly fleet-digest --repo <boards> [--json] [--fail-on-high] [--only-issues] [--webhook <url>]",
      );
      process.exit(2);
    }
    const connected = await connectLocalRepo(repoPath, { scaffold: false });
    const inputs = await loadPortfolioInputs(connected);
    const health = buildFleetHealth(inputs);
    if (opts.onlyIssues && health.ok) {
      // Quiet success for cron when fleet is healthy
      if (opts.failOnHigh) process.exit(0);
      return;
    }
    if (opts.json) {
      console.log(JSON.stringify({ ...health, tiles: undefined }, null, 2));
    } else {
      console.log(formatFleetDigest(health));
    }
    if (opts.webhook) {
      const payload = fleetWebhookPayload(health);
      try {
        const res = await fetch(opts.webhook, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          console.error(
            `webhook POST failed: ${res.status} ${res.statusText}`,
          );
          process.exit(1);
        }
        console.error(`webhook posted ok (${res.status})`);
      } catch (e) {
        console.error(`webhook error: ${e instanceof Error ? e.message : e}`);
        process.exit(1);
      }
    }
    if (opts.failOnHigh && health.highCount > 0) {
      process.exit(1);
    }
    return;
  }

  if (opts.command !== "serve") {
    console.error(`Unknown command: ${opts.command}`);
    printUsage();
    process.exit(1);
  }

  if (!Number.isFinite(opts.port) || opts.port <= 0) {
    console.error(`Invalid --port: ${opts.port}`);
    process.exit(1);
  }

  warnIfPublicBind(opts.host); // loud stderr if non-loopback

  let connected = undefined;
  if (opts.repo) {
    const repoPath = resolve(opts.repo);
    console.log(`Connecting local boards repo: ${repoPath}`);
    connected = await connectLocalRepo(repoPath);
    console.log(
      `Indexed ${connected.index.boards.length} board(s), ${connected.index.cards.length} card(s) @ ${connected.index.sha.slice(0, 8) || "(empty)"}`,
    );
  }

  const server = startServer({
    host: opts.host,
    port: opts.port,
    connected,
    // Real deployment: restore remotes connected in a previous run, which
    // otherwise vanish from the UI on every restart.
    rehydrateConnections: true,
  });

  console.log(`kanbanly serving on http://${server.hostname}:${server.port}`);
  console.log(`  GET  /health`);
  console.log(`  GET  /api/connect   (wizard status)`);
  console.log(`  POST /api/connect   (path | url + optional token)`);
  console.log(`  GET  /api/remotes   (multi-remote sidebar)`);
  console.log(`  GET  /api/boards`);
  console.log(`  POST /api/boards  (create board)`);
  console.log(`  GET  /api/boards/:boardId`);
  console.log(`  POST /api/boards/:boardId/columns  (add list)`);
  console.log(`  PUT  /api/boards/:boardId/columns  (reorder)`);
  console.log(`  PATCH/DELETE /api/boards/:boardId/columns/:colId`);
  console.log(`  POST /api/boards/:boardId/cards`);
  console.log(`  POST /api/boards/:boardId/cards/:cardId/move`);
  console.log(`  GET  /api/events  (SSE board updates)`);
  console.log(`  GET  /api/sync    (push queue status)`);
  console.log(`  POST /api/sync/retry`);
  console.log(`  GET  /  (board UI)`);
  if (connected) {
    console.log(`  live poll every ${server.live?.intervalMs ?? 15_000}ms`);
    console.log(`  push queue debounce 2s`);
  } else {
    console.log(`  no --repo: use Connect wizard in the UI or POST /api/connect`);
  }
}

// Run when executed directly
if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
