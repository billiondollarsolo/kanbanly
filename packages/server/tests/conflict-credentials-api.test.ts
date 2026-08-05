import { describe, expect, test, afterEach } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { serializeCard, type Card } from "@kanbanly/core";
import { connectLocalRepo } from "../src/connect.ts";
import { BoardIndexStore } from "../src/index-store.ts";
import { startServer } from "../src/app.ts";
import { freePort, makeTempRepoFromFixture } from "./helpers.ts";

function card(
  id: string,
  column: string,
  status: string,
  title = "C",
): Card {
  return {
    frontmatter: {
      id,
      title,
      column,
      order: "m",
      updated: "2026-08-04T10:00:00Z",
      labels: [],
    },
    status,
    log: ["2026-08-01 human: created"],
  };
}

describe("conflict resolve + credentials API", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  test("GET/POST conflicts resolve keep-mine and unfreeze", async () => {
    const ctx = makeTempRepoFromFixture();
    cleanups.push(ctx.cleanup);
    const store = new BoardIndexStore();
    const connected = await connectLocalRepo(ctx.repoPath, { indexStore: store });

    const ours = serializeCard(card("c-api1", "doing", "mine", "API conflict"));
    const theirs = serializeCard(
      card("c-api1", "review", "theirs", "API conflict"),
    );
    // Ensure file exists on board
    mkdirSync(join(ctx.repoPath, "backend", "cards"), { recursive: true });
    writeFileSync(
      join(ctx.repoPath, "backend", "cards", "c-api1-api-conflict.md"),
      ours,
    );
    connected.storage.git(["add", "."]);
    connected.storage.git(["commit", "-m", "seed conflict card"]);

    mkdirSync(join(ctx.repoPath, ".kanbanly"), { recursive: true });
    writeFileSync(
      join(ctx.repoPath, ".kanbanly", "conflicts.json"),
      JSON.stringify({
        createdAt: new Date().toISOString(),
        files: [
          {
            path: "backend/cards/c-api1-api-conflict.md",
            boardId: "backend",
            cardId: "c-api1",
            title: "API conflict",
            ours,
            theirs,
          },
        ],
      }),
    );

    // Seed frozen queue
    writeFileSync(
      join(ctx.repoPath, ".kanbanly", "queue.json"),
      JSON.stringify({
        pendingCount: 1,
        frozen: true,
        errorKind: "conflict",
        errorTitle: "Unresolvable conflict — sync frozen",
        errorDetail: "test",
      }),
    );

    const port = await freePort();
    const server = startServer({
      host: "127.0.0.1",
      port,
      connected,
      indexStore: store,
      startLive: false,
      enablePushQueue: true,
      pushDebounceMs: 60_000,
    });
    cleanups.push(() => server.stop(true));

    const list = await fetch(`http://127.0.0.1:${port}/api/conflicts`);
    expect(list.status).toBe(200);
    const listed = (await list.json()) as {
      count: number;
      conflicts: Array<{ cardId: string }>;
    };
    expect(listed.count).toBe(1);
    expect(listed.conflicts[0]?.cardId).toBe("c-api1");

    const res = await fetch(`http://127.0.0.1:${port}/api/conflicts/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        boardId: "backend",
        cardId: "c-api1",
        choice: "mine",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      remaining: number;
      sync: { frozen?: boolean; status: string };
    };
    expect(body.ok).toBe(true);
    expect(body.remaining).toBe(0);
    expect(body.sync.frozen).toBeFalsy();

    const list2 = await fetch(`http://127.0.0.1:${port}/api/conflicts`);
    const listed2 = (await list2.json()) as { count: number };
    expect(listed2.count).toBe(0);
  });

  test("credentials set / status / delete", async () => {
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

    const empty = await fetch(`http://127.0.0.1:${port}/api/credentials`);
    expect((await empty.json() as { configured: boolean }).configured).toBe(false);

    const set = await fetch(`http://127.0.0.1:${port}/api/credentials`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "ghp_secret_for_test", username: "git" }),
    });
    expect(set.status).toBe(200);
    const setBody = (await set.json()) as {
      ok: boolean;
      configured: boolean;
      username?: string;
    };
    expect(setBody.ok).toBe(true);
    expect(setBody.configured).toBe(true);
    expect(setBody.username).toBe("git");
    expect(JSON.stringify(setBody)).not.toContain("ghp_secret_for_test");

    const health = await fetch(`http://127.0.0.1:${port}/health`);
    const h = (await health.json()) as {
      credentials: { configured: boolean };
    };
    expect(h.credentials.configured).toBe(true);

    const del = await fetch(`http://127.0.0.1:${port}/api/credentials`, {
      method: "DELETE",
    });
    expect((await del.json() as { configured: boolean }).configured).toBe(false);
  });

  test("batch pr-status endpoint", async () => {
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
      `http://127.0.0.1:${port}/api/pr-status?prs=${encodeURIComponent("mj/a#1,mj/b#2")}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      statuses: Record<string, { state: string; source: string }>;
    };
    expect(body.statuses["mj/a#1"]?.source).toBe("static");
    expect(body.statuses["mj/b#2"]?.source).toBe("static");
    expect(body.statuses["mj/b#2"]?.state).toBe("unknown");
  });
});
