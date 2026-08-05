/**
 * Project cockpit: code-history (bound code repo) + NOTES.md via real git + HTTP.
 */
import { describe, expect, test, afterEach } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { connectLocalRepo } from "../src/connect.ts";
import { BoardIndexStore } from "../src/index-store.ts";
import { startServer } from "../src/app.ts";
import { freePort, makeTempRepoFromFixture, git } from "./helpers.ts";

function makeCodeRepo(): { path: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "kanbanly-code-"));
  git(root, ["init"]);
  git(root, ["config", "user.name", "dev"]);
  git(root, ["config", "user.email", "dev@test"]);
  git(root, ["checkout", "-b", "main"]);
  writeFileSync(join(root, "README.md"), "# product app\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "feat: initial product scaffold"]);
  writeFileSync(join(root, "main.ts"), "export const x = 1;\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "feat: add main entry"]);
  return {
    path: root,
    cleanup: () => {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    },
  };
}

describe("project cockpit API (real git)", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  test("unbound board: code-history bound=false, not boards log", async () => {
    const ctx = makeTempRepoFromFixture();
    cleanups.push(ctx.cleanup);
    const store = new BoardIndexStore();
    const connected = await connectLocalRepo(ctx.repoPath, { indexStore: store });
    const port = await freePort();
    const server = startServer({
      host: "127.0.0.1",
      port,
      connected,
      indexStore: store,
      enablePushQueue: false,
      startLive: false,
    });
    cleanups.push(() => server.stop(true));
    const base = `http://127.0.0.1:${port}`;

    const res = await fetch(`${base}/api/boards/backend/code-history`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      bound: boolean;
      source: string;
      commits: unknown[];
      error: string | null;
    };
    expect(body.source).toBe("code");
    expect(body.bound).toBe(false);
    expect(body.commits).toEqual([]);
    expect(body.error).toMatch(/path|bound|code/i);
  });

  test("bound path: history subjects from code repo only", async () => {
    const ctx = makeTempRepoFromFixture();
    cleanups.push(ctx.cleanup);
    const code = makeCodeRepo();
    cleanups.push(code.cleanup);

    // Create a boards-only commit with distinctive subject
    writeFileSync(
      join(ctx.repoPath, "backend", "cards", "c-test1-note.md"),
      `---
id: c-test1
title: note
column: backlog
order: "a0"
updated: 2026-08-05T00:00:00Z
---

## Status
_x_

## Log
- 2026-08-05 human: created
`,
    );
    git(ctx.repoPath, ["add", "."]);
    git(ctx.repoPath, ["commit", "-m", "chore(board): should-not-appear-in-code-history"]);

    const store = new BoardIndexStore();
    const connected = await connectLocalRepo(ctx.repoPath, { indexStore: store });
    const port = await freePort();
    const server = startServer({
      host: "127.0.0.1",
      port,
      connected,
      indexStore: store,
      pushDebounceMs: 60_000,
      startLive: false,
    });
    cleanups.push(() => server.stop(true));
    const base = `http://127.0.0.1:${port}`;

    const bind = await fetch(`${base}/api/boards/backend/code-binding`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: code.path }),
    });
    expect(bind.status).toBe(200);

    const hist = await fetch(`${base}/api/boards/backend/code-history`);
    const body = (await hist.json()) as {
      bound: boolean;
      commits: Array<{ subject: string }>;
      codePath: string;
    };
    expect(body.bound).toBe(true);
    expect(body.codePath).toBe(code.path);
    const subjects = body.commits.map((c) => c.subject);
    expect(subjects.some((s) => s.includes("initial product scaffold"))).toBe(
      true,
    );
    expect(subjects.some((s) => s.includes("add main entry"))).toBe(true);
    expect(
      subjects.some((s) => s.includes("should-not-appear-in-code-history")),
    ).toBe(false);
    expect(subjects.some((s) => /chore\(board\)/i.test(s))).toBe(false);
  });

  test("POST code-source clones bare remote and returns product commits", async () => {
    const ctx = makeTempRepoFromFixture();
    cleanups.push(ctx.cleanup);

    // Bare product remote (no auth)
    const root = mkdtempSync(join(tmpdir(), "kanbanly-src-bare-"));
    cleanups.push(() => {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    });
    const bare = join(root, "product.git");
    const seed = join(root, "seed");
    mkdirSync(bare, { recursive: true });
    spawnSync("git", ["init", "--bare"], { cwd: bare, encoding: "utf8" });
    spawnSync("git", ["clone", bare, seed], { encoding: "utf8" });
    spawnSync("git", ["config", "user.name", "dev"], {
      cwd: seed,
      encoding: "utf8",
    });
    spawnSync("git", ["config", "user.email", "d@d"], {
      cwd: seed,
      encoding: "utf8",
    });
    writeFileSync(join(seed, "svc.ts"), "export {}\n");
    spawnSync("git", ["add", "."], { cwd: seed, encoding: "utf8" });
    spawnSync("git", ["commit", "-m", "feat: service bootstrap"], {
      cwd: seed,
      encoding: "utf8",
    });
    spawnSync("git", ["branch", "-M", "main"], { cwd: seed, encoding: "utf8" });
    spawnSync("git", ["push", "-u", "origin", "main"], {
      cwd: seed,
      encoding: "utf8",
    });

    const home = mkdtempSync(join(tmpdir(), "kanbanly-src-home-"));
    cleanups.push(() => {
      try {
        rmSync(home, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    });
    const prevHome = process.env.HOME;
    process.env.HOME = home;

    try {
      const store = new BoardIndexStore();
      const connected = await connectLocalRepo(ctx.repoPath, {
        indexStore: store,
      });
      const port = await freePort();
      const server = startServer({
        host: "127.0.0.1",
        port,
        connected,
        indexStore: store,
        pushDebounceMs: 60_000,
        startLive: false,
      });
      cleanups.push(() => server.stop(true));
      const base = `http://127.0.0.1:${port}`;

      const res = await fetch(`${base}/api/boards/backend/code-source`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: bare, fetch: false }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        ok: boolean;
        source: { path: string; cloned: boolean };
        history: {
          bound: boolean;
          commits: Array<{ subject: string }>;
        };
      };
      expect(body.ok).toBe(true);
      expect(body.source.cloned).toBe(true);
      expect(body.history.bound).toBe(true);
      expect(
        body.history.commits.some((c) =>
          c.subject.includes("service bootstrap"),
        ),
      ).toBe(true);

      const hist = await fetch(`${base}/api/boards/backend/code-history`);
      const h = (await hist.json()) as {
        bound: boolean;
        commits: Array<{ subject: string }>;
      };
      expect(h.bound).toBe(true);
      expect(
        h.commits.some((c) => c.subject.includes("service bootstrap")),
      ).toBe(true);
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
    }
  });

  test("notes PUT/GET round-trip commits NOTES.md", async () => {
    const ctx = makeTempRepoFromFixture();
    cleanups.push(ctx.cleanup);
    const store = new BoardIndexStore();
    const connected = await connectLocalRepo(ctx.repoPath, { indexStore: store });
    const port = await freePort();
    const server = startServer({
      host: "127.0.0.1",
      port,
      connected,
      indexStore: store,
      pushDebounceMs: 60_000,
      startLive: false,
    });
    cleanups.push(() => server.stop(true));
    const base = `http://127.0.0.1:${port}`;

    const empty = await fetch(`${base}/api/boards/backend/notes`);
    const emptyBody = (await empty.json()) as { exists: boolean; body: string };
    expect(emptyBody.exists).toBe(false);

    const put = await fetch(`${base}/api/boards/backend/notes`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        body: "# Backend\n\n## Intent\nShip auth.\n",
      }),
    });
    expect(put.ok).toBe(true);
    const putJ = (await put.json()) as { path: string; sha?: string };
    expect(putJ.path).toBe("backend/NOTES.md");

    const notesPath = join(ctx.repoPath, "backend", "NOTES.md");
    expect(existsSync(notesPath)).toBe(true);
    expect(readFileSync(notesPath, "utf8")).toContain("Ship auth");

    const get = await fetch(`${base}/api/boards/backend/notes`);
    const got = (await get.json()) as { body: string; exists: boolean };
    expect(got.exists).toBe(true);
    expect(got.body).toContain("Ship auth");

    const log = git(ctx.repoPath, ["log", "-1", "--format=%s"]);
    expect(log.stdout).toMatch(/NOTES/i);
  });
});
