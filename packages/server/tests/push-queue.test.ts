/**
 * Push queue: debounce, coalesce, persist, real git push to bare remote.
 */
import { describe, expect, test, afterEach } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { GitStorage, orderInitial } from "@kanbanly/core";
import { PushQueue, defaultQueuePath, labelFor } from "../src/push-queue.ts";
import { connectLocalRepo } from "../src/connect.ts";
import { BoardIndexStore } from "../src/index-store.ts";
import { startServer } from "../src/app.ts";
import {
  freePort,
  git,
  makeBareRemotePair,
  makeTempRepoFromFixture,
} from "./helpers.ts";

describe("labelFor", () => {
  test("matches header copy for sync states", () => {
    expect(labelFor("synced", 0)).toContain("synced");
    expect(labelFor("pending", 3)).toMatch(/3 changes pending/);
    expect(labelFor("syncing", 1)).toMatch(/1 change.*syncing/);
    expect(labelFor("error", 0)).toMatch(/push failed/);
    expect(labelFor("no_remote", 0)).toMatch(/local only/);
    expect(labelFor("no_remote", 4)).toMatch(/4 local · no remote/);
  });
});

describe("PushQueue (real git)", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  test("enqueue without origin is no_remote (not pending push) and persists queue.json", async () => {
    const ctx = makeTempRepoFromFixture();
    cleanups.push(ctx.cleanup);
    const storage = new GitStorage({ repoPath: ctx.repoPath });
    const qPath = defaultQueuePath(ctx.repoPath);
    const q = new PushQueue({ storage, queuePath: qPath, debounceMs: 50_000 });
    cleanups.push(() => q.stop());

    q.enqueue("abc");
    const st = q.getState();
    expect(st.pendingCount).toBe(1);
    // No origin → never claim "pending" push; label shows local commits + no remote.
    expect(st.status).toBe("no_remote");
    expect(st.label).toMatch(/1 local · no remote/);
    expect(existsSync(qPath)).toBe(true);
    const raw = JSON.parse(readFileSync(qPath, "utf8")) as { pendingCount: number };
    expect(raw.pendingCount).toBe(1);

    // Survive reload
    const q2 = new PushQueue({ storage, queuePath: qPath, debounceMs: 50_000 });
    cleanups.push(() => q2.stop());
    expect(q2.getState().pendingCount).toBe(1);
    expect(q2.getState().status).toBe("no_remote");
  });

  test("coalesced enqueue + flush pushes to bare remote", async () => {
    const pair = makeBareRemotePair();
    cleanups.push(pair.cleanup);
    const storage = new GitStorage({
      repoPath: pair.clone,
      remoteUrl: pair.bare,
      maxPushRetries: 3,
    });
    // ensure origin
    storage.git(["remote", "remove", "origin"]);
    storage.git(["remote", "add", "origin", pair.bare]);

    const q = new PushQueue({
      storage,
      queuePath: defaultQueuePath(pair.clone),
      debounceMs: 50_000, // don't auto-flush
    });
    cleanups.push(() => q.stop());

    const c1 = await storage.createCard("backend", "One", "backlog", orderInitial());
    expect(c1.ok).toBe(true);
    q.enqueue(c1.ok ? c1.value.sha : undefined);
    const c2 = await storage.createCard("backend", "Two", "backlog", "a1");
    expect(c2.ok).toBe(true);
    q.enqueue(c2.ok ? c2.value.sha : undefined);
    expect(q.getState().pendingCount).toBe(2);

    const st = await q.flush();
    expect(st.status).toBe("synced");
    expect(st.pendingCount).toBe(0);
    expect(q.flushCount).toBe(1);

    // Remote has the commits
    const log = git(pair.bare, ["log", "--oneline"]);
    expect(log.stdout).toMatch(/create c-/);
  });

  test("HTTP create enqueues push; GET /api/sync reflects pending; flush via retry", async () => {
    const pair = makeBareRemotePair();
    cleanups.push(pair.cleanup);
    // Point clone storage origin
    git(pair.clone, ["remote", "remove", "origin"]);
    git(pair.clone, ["remote", "add", "origin", pair.bare]);

    const store = new BoardIndexStore();
    const connected = await connectLocalRepo(pair.clone, { indexStore: store });
    const port = await freePort();
    const server = startServer({
      host: "127.0.0.1",
      port,
      connected,
      indexStore: store,
      pushDebounceMs: 60_000,
      fetchRemote: false,
      startLive: false,
    });
    cleanups.push(() => server.stop(true));

    const create = await fetch(`http://127.0.0.1:${port}/api/boards/backend/cards`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Queued", column: "backlog" }),
    });
    expect(create.status).toBe(201);
    const body = (await create.json()) as { sync: { pendingCount: number; status: string } };
    expect(body.sync.pendingCount).toBeGreaterThanOrEqual(1);

    const sync = await fetch(`http://127.0.0.1:${port}/api/sync`);
    const state = (await sync.json()) as { pendingCount: number; label: string };
    expect(state.pendingCount).toBeGreaterThanOrEqual(1);
    expect(state.label.length).toBeGreaterThan(0);

    const retry = await fetch(`http://127.0.0.1:${port}/api/sync/retry`, { method: "POST" });
    const after = (await retry.json()) as { status: string; pendingCount: number };
    expect(after.status).toBe("synced");
    expect(after.pendingCount).toBe(0);

    const remoteLog = git(pair.bare, ["log", "--oneline"]);
    expect(remoteLog.stdout).toMatch(/Queued|create c-/);
  });

  test("rapid enqueues schedule one debounced flush", async () => {
    const pair = makeBareRemotePair();
    cleanups.push(pair.cleanup);
    const storage = new GitStorage({ repoPath: pair.clone, remoteUrl: pair.bare });
    storage.git(["remote", "remove", "origin"]);
    storage.git(["remote", "add", "origin", pair.bare]);

    const q = new PushQueue({
      storage,
      queuePath: defaultQueuePath(pair.clone),
      debounceMs: 80,
    });
    cleanups.push(() => q.stop());

    await storage.createCard("backend", "A", "backlog", orderInitial());
    q.enqueue();
    await storage.createCard("backend", "B", "backlog", "a1");
    q.enqueue();
    await storage.createCard("backend", "C", "backlog", "a2");
    q.enqueue();
    expect(q.getState().pendingCount).toBe(3);

    await Bun.sleep(200);
    expect(q.flushCount).toBe(1);
    expect(q.getState().status).toBe("synced");
    expect(q.getState().pendingCount).toBe(0);
  });
});
