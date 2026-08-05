import { describe, expect, test, afterEach } from "bun:test";
import { connectLocalRepo } from "../src/connect.ts";
import { BoardIndexStore } from "../src/index-store.ts";
import { startServer } from "../src/app.ts";
import { freePort, makeTempRepoFromFixture } from "./helpers.ts";

describe("PR overlay API + index", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  test("board cards expose pr field from frontmatter", async () => {
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

    const res = await fetch(`http://127.0.0.1:${port}/api/boards/backend`);
    const body = (await res.json()) as {
      cards: Array<{ id: string; pr?: string }>;
    };
    const withPr = body.cards.find((c) => c.id === "c-c3d4");
    expect(withPr?.pr).toBe("mj/kanbanly#42");
  });

  test("GET /api/pr-status returns static overlay", async () => {
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
      `http://127.0.0.1:${port}/api/pr-status?pr=${encodeURIComponent("mj/api#9")}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      source: string;
      state: string;
      ref: { label: string; url?: string };
      suggestedColumn?: string;
    };
    expect(body.source).toBe("static");
    expect(body.ref.label).toBe("#9");
    expect(body.ref.url).toContain("github.com");
    expect(body.suggestedColumn).toBe("review");
  });
});
