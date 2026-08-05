/**
 * POST /api/boards/:id/columns — append list to board.yml + git commit.
 */
import { describe, expect, test, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { parseBoard } from "@kanbanly/core";
import { connectLocalRepo } from "../src/connect.ts";
import { BoardIndexStore } from "../src/index-store.ts";
import { startServer } from "../src/app.ts";
import { freePort, makeTempRepoFromFixture } from "./helpers.ts";

describe("add column / list (real git)", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  test("POST columns appends board.yml and commits", async () => {
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
      startLive: false,
      enablePushQueue: false,
    });
    cleanups.push(() => server.stop(true));

    const res = await fetch(
      `http://127.0.0.1:${port}/api/boards/backend/columns`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Blocked" }),
      },
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      ok: boolean;
      column: { id: string; name: string };
      columns: Array<{ id: string; name: string }>;
      sha: string;
    };
    expect(body.ok).toBe(true);
    expect(body.column).toEqual({ id: "blocked", name: "Blocked" });
    expect(body.columns.map((c) => c.id)).toContain("blocked");
    expect(body.columns.at(-1)?.id).toBe("blocked");

    const yml = readFileSync(join(ctx.repoPath, "backend", "board.yml"), "utf8");
    const parsed = parseBoard(yml);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.board.columns.map((c) => c.id)).toEqual([
      "backlog",
      "doing",
      "review",
      "done",
      "blocked",
    ]);

    const log = spawnSync("git", ["log", "-1", "--pretty=%s"], {
      cwd: ctx.repoPath,
      encoding: "utf8",
    });
    expect(log.stdout).toMatch(/add column blocked/i);

    // Board detail exposes the new empty column
    const detail = await fetch(
      `http://127.0.0.1:${port}/api/boards/backend`,
    );
    expect(detail.ok).toBe(true);
    const board = (await detail.json()) as {
      columns: Array<{ id: string }>;
      cardsByColumn: Record<string, unknown[]>;
    };
    expect(board.columns.map((c) => c.id)).toContain("blocked");
    expect(board.cardsByColumn.blocked ?? []).toEqual([]);
  });

  test("rejects empty name", async () => {
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
      startLive: false,
      enablePushQueue: false,
    });
    cleanups.push(() => server.stop(true));

    const res = await fetch(
      `http://127.0.0.1:${port}/api/boards/backend/columns`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "  " }),
      },
    );
    expect(res.status).toBe(400);
  });
});
