import { describe, expect, test, afterEach } from "bun:test";
import { connectLocalRepo } from "../src/connect.ts";
import { BoardIndexStore } from "../src/index-store.ts";
import { startServer } from "../src/app.ts";
import { freePort, makeTempRepoFromFixture } from "./helpers.ts";

describe("SPA path deep links (US-15)", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  test("GET /b/:board and /r/:slug/b/:board serve board HTML shell", async () => {
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

    for (const path of [
      "/",
      "/b/backend",
      "/b/backend/c-a1b2",
      "/r/boards/b/backend",
      "/r/boards/b/backend/c-a1b2",
    ]) {
      const res = await fetch(`http://127.0.0.1:${port}${path}`);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('id="root"');
      expect(html).toMatch(/main\.js|Board UI bundle missing/);
    }

    // API still 404s for unknown routes that are not SPA
    const api = await fetch(`http://127.0.0.1:${port}/api/nope`);
    expect(api.status).toBe(404);
  });
});
