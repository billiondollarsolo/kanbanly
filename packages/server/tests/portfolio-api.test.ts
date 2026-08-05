import { describe, expect, test, afterEach } from "bun:test";
import { connectLocalRepo } from "../src/connect.ts";
import { BoardIndexStore } from "../src/index-store.ts";
import { startServer } from "../src/app.ts";
import { freePort, makeTempRepoFromFixture } from "./helpers.ts";

describe("portfolio API", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  test("GET /api/portfolio returns tiles and activity", async () => {
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

    const res = await fetch(`http://127.0.0.1:${port}/api/portfolio`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      tiles: Array<{ boardId: string; cardCount: number; title: string }>;
      activity: unknown[];
      p0Total: number;
      staleTotal: number;
    };
    expect(body.tiles.length).toBeGreaterThanOrEqual(2);
    expect(body.tiles.some((t) => t.boardId === "backend")).toBe(true);
    expect(body.tiles.find((t) => t.boardId === "backend")!.cardCount).toBeGreaterThan(0);
    expect(Array.isArray(body.activity)).toBe(true);
    const full = body as {
      tiles: Array<{
        boardId: string;
        health?: string;
        velocity?: { windowDays: number; done7d: number };
      }>;
      velocity?: { windowDays: number; done7d: number };
    };
    expect(full.tiles[0]!.velocity?.windowDays).toBe(7);
    expect(typeof full.tiles[0]!.health).toBe("string");
    expect(full.velocity?.windowDays).toBe(7);
  });
});
