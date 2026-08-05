import { describe, expect, test, afterEach } from "bun:test";
import { connectLocalRepo } from "../src/connect.ts";
import { BoardIndexStore } from "../src/index-store.ts";
import { startServer, renderBoardAppHtml } from "../src/app.ts";
import { freePort, makeTempRepoFromFixture } from "./helpers.ts";

describe("activity API + theme boot", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  test("GET /api/boards/:id/activity returns rolled-up log entries", async () => {
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
      `http://127.0.0.1:${port}/api/boards/backend/activity?limit=50`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      boardId: string;
      entries: Array<{ cardId: string; line: string; date: string }>;
      count: number;
    };
    expect(body.boardId).toBe("backend");
    expect(body.count).toBeGreaterThan(0);
    expect(body.entries.every((e) => e.cardId && e.line)).toBe(true);
    // Fixture cards have log lines with dates
    expect(body.entries.some((e) => e.date.startsWith("2026-"))).toBe(true);
  });

  test("board HTML includes FOUC theme boot script", () => {
    const html = renderBoardAppHtml();
    expect(html).toContain("kanbanly-theme");
    expect(html).toContain("data-theme");
    expect(html).toContain("localStorage");
  });
});
