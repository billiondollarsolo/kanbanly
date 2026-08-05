/**
 * Manual pull API + second-clone SSE e2e (US-14).
 */
import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { GitStorage, orderInitial, defaultBoardYaml } from "@kanbanly/core";
import { connectLocalRepo } from "../src/connect.ts";
import { BoardIndexStore } from "../src/index-store.ts";
import { startServer } from "../src/app.ts";
import { freePort } from "./helpers.ts";

function git(cwd: string, args: string[]) {
  return spawnSync("git", args, { cwd, encoding: "utf8" });
}

function barePair() {
  const root = mkdtempSync(join(tmpdir(), "kanbanly-sse2-"));
  const bare = join(root, "remote.git");
  const a = join(root, "a");
  const b = join(root, "b");
  mkdirSync(bare, { recursive: true });
  git(bare, ["init", "--bare"]);
  const seed = join(root, "seed");
  git(root, ["clone", bare, seed]);
  git(seed, ["config", "user.name", "s"]);
  git(seed, ["config", "user.email", "s@t"]);
  mkdirSync(join(seed, "backend", "cards"), { recursive: true });
  writeFileSync(join(seed, "backend", "board.yml"), defaultBoardYaml());
  git(seed, ["add", "."]);
  git(seed, ["commit", "-m", "init"]);
  git(seed, ["branch", "-M", "main"]);
  git(seed, ["push", "-u", "origin", "main"]);
  git(root, ["clone", bare, a]);
  git(a, ["config", "user.name", "a"]);
  git(a, ["config", "user.email", "a@t"]);
  git(root, ["clone", bare, b]);
  git(b, ["config", "user.name", "b"]);
  git(b, ["config", "user.email", "b@t"]);
  return {
    root,
    bare,
    a,
    b,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe("POST /api/sync/pull", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  test("pulls remote commits into connected clone", async () => {
    const ctx = barePair();
    cleanups.push(ctx.cleanup);

    const sa = new GitStorage({ repoPath: ctx.a, remoteUrl: ctx.bare });
    sa.git(["remote", "remove", "origin"]);
    sa.git(["remote", "add", "origin", ctx.bare]);
    const created = await sa.createCard(
      "backend",
      "From A",
      "backlog",
      orderInitial(),
    );
    expect(created.ok).toBe(true);
    expect((await sa.push()).ok).toBe(true);

    // B is behind; server connected to B
    const store = new BoardIndexStore();
    const connected = await connectLocalRepo(ctx.b, { indexStore: store });
    connected.storage.git(["remote", "remove", "origin"]);
    connected.storage.git(["remote", "add", "origin", ctx.bare]);

    const port = await freePort();
    const server = startServer({
      host: "127.0.0.1",
      port,
      connected,
      indexStore: store,
      startLive: false,
      enablePushQueue: false,
      fetchRemote: false,
    });
    cleanups.push(() => server.stop(true));

    const before = await fetch(`http://127.0.0.1:${port}/api/boards/backend`);
    const beforeBody = (await before.json()) as { cards: unknown[] };
    expect(beforeBody.cards.length).toBe(0);

    const pull = await fetch(`http://127.0.0.1:${port}/api/sync/pull`, {
      method: "POST",
    });
    expect(pull.status).toBe(200);
    const body = (await pull.json()) as {
      ok: boolean;
      fetched: boolean;
      fastForwarded: boolean;
      sha: string;
    };
    expect(body.ok).toBe(true);
    expect(body.fetched).toBe(true);
    expect(body.fastForwarded).toBe(true);

    const after = await fetch(`http://127.0.0.1:${port}/api/boards/backend`);
    const afterBody = (await after.json()) as {
      cards: Array<{ title: string }>;
    };
    expect(afterBody.cards.some((c) => c.title === "From A")).toBe(true);
  });
});

describe("SSE second-clone live update (US-14)", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  test("external commit on same clone is seen via poll tick", async () => {
    const ctx = barePair();
    cleanups.push(ctx.cleanup);

    const store = new BoardIndexStore();
    const connected = await connectLocalRepo(ctx.a, { indexStore: store });
    const port = await freePort();
    const server = startServer({
      host: "127.0.0.1",
      port,
      connected,
      indexStore: store,
      startLive: true,
      pollIntervalMs: 200,
      enablePushQueue: false,
      fetchRemote: false,
    });
    cleanups.push(() => server.stop(true));

    // Subscribe SSE
    const ac = new AbortController();
    const events: Array<{ sha: string; reason: string }> = [];
    const esPromise = (async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/events`, {
        signal: ac.signal,
        headers: { accept: "text/event-stream" },
      });
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let buf = "";
      while (events.length < 2) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split("\n\n");
        buf = parts.pop() ?? "";
        for (const p of parts) {
          const dataLine = p.split("\n").find((l) => l.startsWith("data:"));
          if (!dataLine) continue;
          try {
            const data = JSON.parse(dataLine.slice(5).trim()) as {
              sha: string;
              reason: string;
            };
            events.push(data);
          } catch {
            /* ignore */
          }
        }
      }
    })();

    // External write on the same repo (simulates second process / agent)
    await new Promise((r) => setTimeout(r, 100));
    const ext = new GitStorage({ repoPath: ctx.a });
    await ext.createCard("backend", "SSE external", "doing", orderInitial());

    // Force a poll tick
    await server.live?.tick();
    await Promise.race([
      esPromise,
      new Promise((r) => setTimeout(r, 2000)),
    ]);
    ac.abort();

    expect(events.some((e) => e.reason === "hello" || e.reason === "poll" || e.reason === "write")).toBe(
      true,
    );
    // After tick, board should include the new card
    const board = await fetch(`http://127.0.0.1:${port}/api/boards/backend`);
    const body = (await board.json()) as { cards: Array<{ title: string }> };
    expect(body.cards.some((c) => c.title === "SSE external")).toBe(true);
  });
});
