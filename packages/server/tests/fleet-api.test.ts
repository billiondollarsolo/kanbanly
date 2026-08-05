import { describe, expect, test, afterEach } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { connectLocalRepo } from "../src/connect.ts";
import { BoardIndexStore } from "../src/index-store.ts";
import { startServer } from "../src/app.ts";
import { freePort, makeTempRepoFromFixture, git } from "./helpers.ts";

describe("fleet + session-end API", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  test("GET /api/fleet-health returns issues shape", async () => {
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

    const res = await fetch(`http://127.0.0.1:${port}/api/fleet-health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      boardCount: number;
      issues: unknown[];
      summary: { p0Total: number };
    };
    expect(body.boardCount).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(body.issues)).toBe(true);
    expect(typeof body.summary.p0Total).toBe("number");
  });

  test("POST session-end appends log via HTTP", async () => {
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

    const res = await fetch(
      `http://127.0.0.1:${port}/api/boards/backend/cards/c-a1b2/session-end`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          summary: "fleet agent finished batch",
          agent: "agent-7",
          sha: "abc1234",
          status: "Batch complete.",
        }),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; logLine: string };
    expect(body.ok).toBe(true);
    expect(body.logLine).toContain("session-end");
    expect(body.logLine).toContain("abc1234");

    const md = (
      await (
        await fetch(`http://127.0.0.1:${port}/api/boards/backend`)
      ).json()
    ) as { cards: Array<{ id: string; log: string[] }> };
    const card = md.cards.find((c) => c.id === "c-a1b2");
    expect(card?.log.some((l) => l.includes("session-end"))).toBe(true);
  });

  test("hard WIP returns 409 when moving into Doing over limit", async () => {
    const ctx = makeTempRepoFromFixture();
    cleanups.push(ctx.cleanup);
    // Force wipHard + limit 1 on backend
    const yml = `id: backend
title: backend
columns:
  - id: backlog
    name: Backlog
  - id: doing
    name: Doing
  - id: review
    name: Review
  - id: done
    name: Done
settings:
  wipDoing: 1
  wipHard: true
`;
    writeFileSync(join(ctx.repoPath, "backend", "board.yml"), yml);
    git(ctx.repoPath, ["add", "."]);
    git(ctx.repoPath, ["commit", "-m", "chore: wip hard"]);

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

    // c-c3d4 already in doing in fixture; try move c-a1b2 backlog → doing
    const res = await fetch(
      `http://127.0.0.1:${port}/api/boards/backend/cards/c-a1b2/move`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ column: "doing" }),
      },
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("wip_hard");
  });
});
