import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { connectLocalRepo, ensureBoardScaffold } from "../src/connect.ts";
import { BoardIndexStore } from "../src/index-store.ts";
import { startServer } from "../src/app.ts";
import { freePort, makeTempRepoFromFixture } from "./helpers.ts";
import { runMergeDriver, serializeCard, type Card } from "@kanbanly/core";

describe("connect wizard + scaffold", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  test("ensureBoardScaffold creates layout A board when empty", () => {
    const root = mkdtempSync(join(tmpdir(), "kanbanly-scaffold-"));
    cleanups.push(() => {});
    mkdirSync(root, { recursive: true });
    const r = ensureBoardScaffold(root, "backend");
    expect(r.created).toBe(true);
    expect(existsSync(join(root, "backend", "board.yml"))).toBe(true);
    expect(existsSync(join(root, "backend", "cards"))).toBe(true);
  });

  test("POST /api/connect with local path indexes boards", async () => {
    const ctx = makeTempRepoFromFixture();
    cleanups.push(ctx.cleanup);
    const store = new BoardIndexStore();
    const port = await freePort();
    // Start WITHOUT connected repo — wizard path
    const server = startServer({
      host: "127.0.0.1",
      port,
      indexStore: store,
      startLive: false,
      enablePushQueue: false,
    });
    cleanups.push(() => server.stop(true));

    const empty = await fetch(`http://127.0.0.1:${port}/api/connect`);
    expect((await empty.json() as { connected: boolean }).connected).toBe(false);

    const res = await fetch(`http://127.0.0.1:${port}/api/connect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: ctx.repoPath }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      boards: Array<{ id: string }>;
      cardCount: number;
    };
    expect(body.ok).toBe(true);
    expect(body.boards.map((b) => b.id).sort()).toEqual(["backend", "web"]);
    expect(body.cardCount).toBeGreaterThan(0);

    const boards = await fetch(`http://127.0.0.1:${port}/api/boards`);
    const listed = (await boards.json()) as { boards: unknown[] };
    expect(listed.boards.length).toBe(2);
  });

  test("POST /api/connect scaffolds empty git repo", async () => {
    const root = mkdtempSync(join(tmpdir(), "kanbanly-empty-git-"));
    const repo = join(root, "boards");
    mkdirSync(repo, { recursive: true });
    spawnSync("git", ["init"], { cwd: repo });
    spawnSync("git", ["config", "user.name", "t"], { cwd: repo });
    spawnSync("git", ["config", "user.email", "t@t"], { cwd: repo });
    // empty commit so HEAD exists for index
    spawnSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: repo });
    cleanups.push(() => {});

    const port = await freePort();
    const server = startServer({
      host: "127.0.0.1",
      port,
      startLive: false,
      enablePushQueue: false,
    });
    cleanups.push(() => server.stop(true));

    const res = await fetch(`http://127.0.0.1:${port}/api/connect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: repo, scaffold: true, board: "backend" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      boards: Array<{ id: string }>;
    };
    expect(body.ok).toBe(true);
    expect(body.boards.some((b) => b.id === "backend")).toBe(true);
    expect(existsSync(join(repo, "backend", "board.yml"))).toBe(true);
  });

  test("connectLocalRepo rejects non-git with friendly error", async () => {
    const root = mkdtempSync(join(tmpdir(), "kanbanly-nongit-"));
    await expect(connectLocalRepo(root)).rejects.toThrow(/Not a git repository/);
  });
});

describe("merge-driver CLI entry", () => {
  test("runMergeDriver writes merged result to ours path", async () => {
    const root = mkdtempSync(join(tmpdir(), "kanbanly-md-"));
    const card = (col: string, updated: string, status: string): Card => ({
      frontmatter: {
        id: "c-md01",
        title: "Merge",
        column: col,
        order: "m",
        updated,
        labels: [],
      },
      status,
      log: ["2026-08-01 human: created"],
    });
    const base = serializeCard(card("backlog", "2026-08-01T00:00:00Z", "base"));
    const ours = serializeCard(card("doing", "2026-08-04T10:00:00Z", "ours"));
    const theirs = serializeCard(card("review", "2026-08-04T12:00:00Z", "theirs"));
    const pO = join(root, "O.md");
    const pA = join(root, "A.md");
    const pB = join(root, "B.md");
    writeFileSync(pO, base);
    writeFileSync(pA, ours);
    writeFileSync(pB, theirs);

    await runMergeDriver(pO, pA, pB);
    const result = await Bun.file(pA).text();
    expect(result).toContain("column: review");
    expect(result).toContain("theirs");
  });
});
