import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  cpSync,
  existsSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

export function git(cwd: string, args: string[]) {
  return spawnSync("git", args, { cwd, encoding: "utf8" });
}

/** Absolute path to the layout-A fixture in the monorepo. */
export function fixtureLayoutA(): string {
  return join(import.meta.dir, "../../../fixtures/boards-layout-a");
}

/**
 * Create a temp git repo seeded from fixtures/boards-layout-a (layout A).
 * Returns the clone path and a cleanup function.
 */
export function makeTempRepoFromFixture(): {
  repoPath: string;
  root: string;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), "kanbanly-server-"));
  const repoPath = join(root, "boards");
  mkdirSync(repoPath, { recursive: true });

  // Copy fixture contents (board.yml + cards for backend/web)
  const fixture = fixtureLayoutA();
  cpSync(fixture, repoPath, { recursive: true });

  // Init git and commit
  git(repoPath, ["init"]);
  git(repoPath, ["config", "user.name", "kanbanly-test"]);
  git(repoPath, ["config", "user.email", "kanbanly-test@local"]);
  git(repoPath, ["checkout", "-b", "main"]);
  git(repoPath, ["add", "."]);
  const commit = git(repoPath, ["commit", "-m", "init layout A fixture"]);
  if (commit.status !== 0) {
    throw new Error(`fixture commit failed: ${commit.stderr || commit.stdout}`);
  }

  return {
    repoPath,
    root,
    cleanup: () => {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    },
  };
}

/**
 * Create a minimal empty layout-A temp git repo (backend board only).
 */
export function makeEmptyLayoutARepo(): {
  repoPath: string;
  root: string;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), "kanbanly-server-empty-"));
  const repoPath = join(root, "boards");
  mkdirSync(join(repoPath, "backend", "cards"), { recursive: true });
  writeFileSync(
    join(repoPath, "backend", "board.yml"),
    `columns:
  - id: backlog
    name: Backlog
  - id: doing
    name: Doing
  - id: review
    name: Review
  - id: done
    name: Done
labels: []
settings: {}
`,
  );
  git(repoPath, ["init"]);
  git(repoPath, ["config", "user.name", "kanbanly-test"]);
  git(repoPath, ["config", "user.email", "kanbanly-test@local"]);
  git(repoPath, ["checkout", "-b", "main"]);
  git(repoPath, ["add", "."]);
  git(repoPath, ["commit", "-m", "init empty layout A"]);
  return {
    repoPath,
    root,
    cleanup: () => {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    },
  };
}

export function fileExists(path: string): boolean {
  return existsSync(path);
}

export function readText(path: string): string {
  return readFileSync(path, "utf8");
}

/** Find a free loopback port by binding briefly. */
export async function freePort(): Promise<number> {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("ok"),
  });
  const port = server.port;
  server.stop(true);
  return port;
}
