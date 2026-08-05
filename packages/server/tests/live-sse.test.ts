/**
 * Poll + SSE live updates — real git, no mocks.
 */
import { describe, expect, test, afterEach } from "bun:test";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { LiveHub, formatSse } from "../src/live.ts";
import { BoardIndexStore } from "../src/index-store.ts";
import { connectLocalRepo } from "../src/connect.ts";
import { startServer } from "../src/app.ts";
import { makeTempRepoFromFixture, freePort } from "./helpers.ts";
import { defaultBoardYaml } from "@kanbanly/core";

async function readSseEvents(
  res: Response,
  count: number,
  timeoutMs = 5000,
): Promise<Array<{ event: string; data: string }>> {
  if (!res.body) throw new Error("no body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const events: Array<{ event: string; data: string }> = [];
  const deadline = Date.now() + timeoutMs;

  while (events.length < count && Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const readPromise = reader.read();
    const timeoutPromise = new Promise<{ done: true; value: undefined }>((resolve) =>
      setTimeout(() => resolve({ done: true, value: undefined }), remaining),
    );
    const { done, value } = await Promise.race([readPromise, timeoutPromise]);
    if (done && !value) break;
    if (value) buf += decoder.decode(value, { stream: true });

    // Parse SSE frames separated by blank lines
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let event = "message";
      let data = "";
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (data) events.push({ event, data });
    }
  }
  try {
    await reader.cancel();
  } catch {
    /* ignore */
  }
  return events;
}

describe("formatSse", () => {
  test("serializes board event", () => {
    const s = formatSse({
      type: "board",
      sha: "abc",
      reason: "write",
      at: "2026-08-04T00:00:00Z",
    });
    expect(s).toContain("event: board");
    expect(s).toContain('"sha":"abc"');
    expect(s).toContain('"reason":"write"');
    expect(s.endsWith("\n\n")).toBe(true);
  });
});

describe("LiveHub poll + SSE (real git)", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  test("subscribe sends hello with current sha", async () => {
    const ctx = makeTempRepoFromFixture();
    cleanups.push(ctx.cleanup);
    const store = new BoardIndexStore();
    const connected = await connectLocalRepo(ctx.repoPath, { indexStore: store });
    const hub = new LiveHub({
      connected,
      indexStore: store,
      intervalMs: 60_000,
      fetchRemote: false,
    });
    cleanups.push(() => hub.stop());

    const res = hub.subscribe();
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    const events = await readSseEvents(res, 1);
    expect(events.length).toBeGreaterThanOrEqual(1);
    const hello = JSON.parse(events[0]!.data) as { reason: string; sha: string };
    expect(hello.reason).toBe("hello");
    expect(hello.sha).toMatch(/^[0-9a-f]{40}$/);
  });

  test("notifyWrite broadcasts to SSE clients", async () => {
    const ctx = makeTempRepoFromFixture();
    cleanups.push(ctx.cleanup);
    const store = new BoardIndexStore();
    const connected = await connectLocalRepo(ctx.repoPath, { indexStore: store });
    const hub = new LiveHub({
      connected,
      indexStore: store,
      intervalMs: 60_000,
      fetchRemote: false,
    });
    cleanups.push(() => hub.stop());

    // Use a manual stream reader so we can read hello then write without race
    const res = hub.subscribe();
    expect(hub.clientCount()).toBe(1);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    const readOne = async () => {
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const idx = buf.indexOf("\n\n");
        if (idx >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
          if (dataLine) return JSON.parse(dataLine.slice(5).trim()) as { reason: string; sha: string };
        }
      }
      throw new Error("timeout waiting for SSE event");
    };

    const hello = await readOne();
    expect(hello.reason).toBe("hello");

    const before = hub.broadcastCount;
    hub.notifyWrite("deadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
    expect(hub.broadcastCount).toBe(before + 1);

    const writeEv = await readOne();
    expect(writeEv.reason).toBe("write");
    expect(writeEv.sha).toBe("deadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
    await reader.cancel();
  });

  test("tick detects external git commit and broadcasts poll event", async () => {
    const ctx = makeTempRepoFromFixture();
    cleanups.push(ctx.cleanup);
    const store = new BoardIndexStore();
    const connected = await connectLocalRepo(ctx.repoPath, { indexStore: store });
    const hub = new LiveHub({
      connected,
      indexStore: store,
      intervalMs: 60_000,
      fetchRemote: false,
    });
    cleanups.push(() => hub.stop());

    const shaBefore = connected.storage.headSha();

    // External commit (simulates agent push landing on same clone / pull)
    const cardsDir = join(ctx.repoPath, "backend", "cards");
    mkdirSync(cardsDir, { recursive: true });
    writeFileSync(
      join(cardsDir, "c-zzzz-external.md"),
      `---
id: c-zzzz
title: External
column: backlog
order: "z9"
updated: 2026-08-04T12:00:00Z
---

## Status
from agent

## Log
- 2026-08-04 agent: created
`,
    );
    spawnSync("git", ["add", "."], { cwd: ctx.repoPath });
    spawnSync("git", ["-c", "user.name=agent", "-c", "user.email=a@a", "commit", "-m", "agent card"], {
      cwd: ctx.repoPath,
    });
    const shaAfter = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: ctx.repoPath,
      encoding: "utf8",
    }).stdout.trim();
    expect(shaAfter).not.toBe(shaBefore);

    const res = hub.subscribe();
    const collect = readSseEvents(res, 2, 4000);
    await Bun.sleep(30);
    const result = await hub.tick();
    expect(result.changed).toBe(true);
    expect(result.sha).toBe(shaAfter);

    const events = await collect;
    const poll = events
      .map((e) => JSON.parse(e.data) as { reason: string; sha: string })
      .find((e) => e.reason === "poll");
    expect(poll).toBeTruthy();
    expect(poll!.sha).toBe(shaAfter);

    // Index includes external card
    const board = store.getBoard(connected.remoteKey, "backend");
    expect(board?.cards.some((c) => c.id === "c-zzzz")).toBe(true);
  });

  test("HTTP create card emits SSE write event via startServer live hub", async () => {
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
      pollIntervalMs: 60_000,
      fetchRemote: false,
      startLive: true,
    });
    cleanups.push(() => server.stop(true));

    const sseRes = await fetch(`http://127.0.0.1:${port}/api/events`);
    expect(sseRes.status).toBe(200);
    expect(sseRes.headers.get("content-type")).toMatch(/text\/event-stream/);

    const collect = readSseEvents(sseRes, 2, 5000);
    await Bun.sleep(80);

    const create = await fetch(`http://127.0.0.1:${port}/api/boards/backend/cards`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Live card", column: "backlog" }),
    });
    expect(create.status).toBe(201);
    const created = (await create.json()) as { sha: string };

    const events = await collect;
    const parsed = events.map((e) => JSON.parse(e.data) as { reason: string; sha: string });
    expect(parsed.some((e) => e.reason === "hello")).toBe(true);
    const writeEv = parsed.find((e) => e.reason === "write");
    expect(writeEv).toBeTruthy();
    expect(writeEv!.sha).toBe(created.sha);

    const health = await fetch(`http://127.0.0.1:${port}/health`);
    const h = (await health.json()) as { ok: boolean; live: { clients: number; sha: string } };
    expect(h.ok).toBe(true);
    expect(h.live.sha).toBe(created.sha);
  });

  test("tick unchanged SHA does not broadcast poll", async () => {
    const ctx = makeTempRepoFromFixture();
    cleanups.push(ctx.cleanup);
    const store = new BoardIndexStore();
    const connected = await connectLocalRepo(ctx.repoPath, { indexStore: store });
    const hub = new LiveHub({
      connected,
      indexStore: store,
      intervalMs: 60_000,
      fetchRemote: false,
    });
    cleanups.push(() => hub.stop());

    const before = hub.broadcastCount;
    const r1 = await hub.tick();
    expect(r1.changed).toBe(false);
    const r2 = await hub.tick();
    expect(r2.changed).toBe(false);
    // no poll broadcasts
    expect(hub.broadcastCount).toBe(before);
  });
});
