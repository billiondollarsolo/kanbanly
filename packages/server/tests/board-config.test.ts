/**
 * Board config APIs: rename/reorder/delete columns + create board.
 */
import { describe, expect, test, afterEach } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseBoard } from "@kanbanly/core";
import { connectLocalRepo } from "../src/connect.ts";
import { BoardIndexStore } from "../src/index-store.ts";
import { startServer } from "../src/app.ts";
import { freePort, makeTempRepoFromFixture } from "./helpers.ts";

describe("board config APIs (real git)", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  async function boot() {
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
    return { ctx, port, base: `http://127.0.0.1:${port}` };
  }

  test("PATCH rename column", async () => {
    const { base, ctx } = await boot();
    const res = await fetch(`${base}/api/boards/backend/columns/doing`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "In progress" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { column: { id: string; name: string } };
    expect(body.column).toEqual({ id: "doing", name: "In progress" });
    const yml = parseBoard(
      readFileSync(join(ctx.repoPath, "backend", "board.yml"), "utf8"),
    );
    expect(yml.ok).toBe(true);
    if (!yml.ok) return;
    expect(yml.board.columns.find((c) => c.id === "doing")?.name).toBe(
      "In progress",
    );
  });

  test("PUT reorder columns", async () => {
    const { base, ctx } = await boot();
    const res = await fetch(`${base}/api/boards/backend/columns`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        order: ["done", "review", "doing", "backlog"],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { columns: Array<{ id: string }> };
    expect(body.columns.map((c) => c.id)).toEqual([
      "done",
      "review",
      "doing",
      "backlog",
    ]);
    const yml = parseBoard(
      readFileSync(join(ctx.repoPath, "backend", "board.yml"), "utf8"),
    );
    expect(yml.ok).toBe(true);
    if (!yml.ok) return;
    expect(yml.board.columns.map((c) => c.id)).toEqual([
      "done",
      "review",
      "doing",
      "backlog",
    ]);
  });

  test("DELETE empty-ish column after moving cards", async () => {
    const { base, ctx } = await boot();
    // backend fixture has cards in backlog — delete backlog by moving to doing
    const res = await fetch(`${base}/api/boards/backend/columns/backlog`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ moveTo: "doing" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      columns: Array<{ id: string }>;
      moved: number;
    };
    expect(body.columns.map((c) => c.id)).not.toContain("backlog");
    expect(body.moved).toBeGreaterThan(0);

    const yml = parseBoard(
      readFileSync(join(ctx.repoPath, "backend", "board.yml"), "utf8"),
    );
    expect(yml.ok).toBe(true);
    if (!yml.ok) return;
    expect(yml.board.columns.map((c) => c.id)).not.toContain("backlog");

    // Cards on disk should no longer say column: backlog
    const cardsDir = join(ctx.repoPath, "backend", "cards");
    for (const f of readdirSync(cardsDir).filter((x) => x.endsWith(".md"))) {
      const text = readFileSync(join(cardsDir, f), "utf8");
      expect(text).not.toMatch(/column:\s*backlog/);
    }
  });

  test("POST create board layout A", async () => {
    const { base, ctx } = await boot();
    const res = await fetch(`${base}/api/boards`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Mobile App" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { boardId: string; title?: string };
    expect(body.boardId).toMatch(/^b-[0-9a-f]{24}$/);
    expect(existsSync(join(ctx.repoPath, body.boardId, "board.yml"))).toBe(true);
    expect(existsSync(join(ctx.repoPath, body.boardId, "cards"))).toBe(true);
    const yml = readFileSync(
      join(ctx.repoPath, body.boardId, "board.yml"),
      "utf8",
    );
    expect(yml).toMatch(/title:\s*Mobile App/);

    const list = await fetch(`${base}/api/boards`);
    const listed = (await list.json()) as {
      boards: Array<{ id: string; title?: string }>;
    };
    expect(listed.boards.map((b) => b.id)).toContain(body.boardId);
    const created = listed.boards.find((b) => b.id === body.boardId);
    expect(created?.title).toBe("Mobile App");
  });
});
