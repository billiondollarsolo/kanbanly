#!/usr/bin/env bun
/**
 * kanbanly CLI — OSS server entry.
 *
 *   kanbanly serve [--host 127.0.0.1] [--port 3847] [--repo <path>]
 *   kanbanly merge-driver %O %A %B
 *   kanbanly setup --code <path> --boards <path> --remote <url> [--board <id>]
 *   kanbanly skill-install [--path <dir>]
 */
import { resolve } from "node:path";
import {
  kanbanlySetup,
  runMergeDriver,
  skillInstall,
} from "@kanbanly/core";
import { connectLocalRepo } from "./connect.ts";
import { startServer } from "./app.ts";

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 3847;

export const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

function printUsage(): void {
  console.log(`kanbanly — git-backed kanban

Usage:
  kanbanly serve [--host 127.0.0.1] [--port 3847] [--repo <path>]
  kanbanly merge-driver <ancestor> <ours> <theirs>
  kanbanly setup --code <path> --boards <path> --remote <url> [--board <id>]
  kanbanly skill-install [--path <dir>]

Options:
  --host   Bind address (default: 127.0.0.1). Non-loopback prints a loud warning.
  --port   Port (default: 3847)
  --repo   Path to a local boards git repository (layout A or B)
  --code   Code repo root for setup (writes .kanbanly.yml)
  --boards Boards repo path for setup
  --remote Boards remote URL for setup
  --board  Layout A board id when scaffolding (default: backend)
  --path   Target directory for skill-install
  -h, --help  Show this help
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
  let repo: string | undefined;
  let code: string | undefined;
  let boards: string | undefined;
  let remote: string | undefined;
  let board: string | undefined;
  let path: string | undefined;
  let help = false;
  const rest: string[] = [];

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
    } else if (!a.startsWith("-")) {
      rest.push(a);
    }
  }

  return { command, host, port, repo, code, boards, remote, board, path, help, rest };
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
  });

  console.log(`kanbanly serving on http://${server.hostname}:${server.port}`);
  console.log(`  GET  /health`);
  console.log(`  GET  /api/connect   (wizard status)`);
  console.log(`  POST /api/connect   (path | url + optional token)`);
  console.log(`  GET  /api/remotes   (multi-remote sidebar)`);
  console.log(`  GET  /api/boards`);
  console.log(`  GET  /api/boards/:boardId`);
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
