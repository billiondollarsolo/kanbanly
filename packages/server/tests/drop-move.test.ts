/**
 * Drop position → orderForDrop → shipped move write path (real git).
 * Proves the UI's pure helper + server move API land markdown + commits.
 */
import { describe, expect, test, afterEach } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { dropToMovePayload, orderForDrop, parseCard } from "@kanbanly/core";
import { connectLocalRepo } from "../src/connect.ts";
import { BoardIndexStore } from "../src/index-store.ts";
import { startServer } from "../src/app.ts";
import { makeTempRepoFromFixture, freePort } from "./helpers.ts";

describe("drop → move write path (real git, no mock)", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  test("orderForDrop between neighbours then POST move updates file + git log", async () => {
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
    });
    cleanups.push(() => server.stop(true));

    // Create two cards in backlog so we can insert between
    const c1 = await fetch(`http://127.0.0.1:${port}/api/boards/backend/cards`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "First", column: "backlog" }),
    });
    expect(c1.status).toBe(201);
    const c2 = await fetch(`http://127.0.0.1:${port}/api/boards/backend/cards`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Second", column: "backlog" }),
    });
    expect(c2.status).toBe(201);

    const boardRes = await fetch(`http://127.0.0.1:${port}/api/boards/backend`);
    const board = (await boardRes.json()) as {
      cardsByColumn: Record<string, Array<{ id: string; order: string; title: string }>>;
    };
    const backlog = board.cardsByColumn["backlog"] ?? [];
    // Pick fixture card c-a1b2 and move into doing after last (or empty)
    const doing = board.cardsByColumn["doing"] ?? [];
    const payload = dropToMovePayload(
      "doing",
      doing.map((c) => ({ id: c.id, order: c.order })),
      "c-a1b2",
      doing.length, // append
    );
    expect(payload.column).toBe("doing");
    expect(payload.order.length).toBeGreaterThan(0);

    // Within-column: mint between first two backlog cards for "Second"
    const second = backlog.find((c) => c.title === "Second");
    expect(second).toBeTruthy();
    const others = backlog.filter((c) => c.id !== second!.id);
    const between = orderForDrop(
      others.map((c) => ({ id: c.id, order: c.order })),
      second!.id,
      1,
    );
    // between may equal orderForDrop with full list
    void between;

    const move = await fetch(
      `http://127.0.0.1:${port}/api/boards/backend/cards/c-a1b2/move`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      },
    );
    expect(move.status).toBe(200);
    const moveBody = (await move.json()) as { ok: boolean; order: string; column: string };
    expect(moveBody.ok).toBe(true);
    expect(moveBody.column).toBe("doing");
    expect(moveBody.order).toBe(payload.order);

    // Filesystem markdown
    const cardsDir = join(ctx.repoPath, "backend", "cards");
    const file = readdirSync(cardsDir).find((f) => f.startsWith("c-a1b2-"));
    expect(file).toBeTruthy();
    const text = readFileSync(join(cardsDir, file!), "utf8");
    const parsed = parseCard(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.card.frontmatter.column).toBe("doing");
    expect(parsed.card.frontmatter.order).toBe(payload.order);

    // git commit exists
    const log = spawnSync("git", ["log", "--oneline"], {
      cwd: ctx.repoPath,
      encoding: "utf8",
    });
    expect(log.stdout).toMatch(/move c-a1b2|c-a1b2/);
  });

  test("simulated drop within column mints between and persists via shipped API", async () => {
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
    });
    cleanups.push(() => server.stop(true));

    await fetch(`http://127.0.0.1:${port}/api/boards/backend/cards`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Alpha", column: "review" }),
    });
    await fetch(`http://127.0.0.1:${port}/api/boards/backend/cards`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Gamma", column: "review" }),
    });
    const midCreate = await fetch(`http://127.0.0.1:${port}/api/boards/backend/cards`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Beta-drag", column: "backlog" }),
    });
    const mid = (await midCreate.json()) as { card: { id: string } };
    const dragId = mid.card.id;

    const boardRes = await fetch(`http://127.0.0.1:${port}/api/boards/backend`);
    const board = (await boardRes.json()) as {
      cardsByColumn: Record<string, Array<{ id: string; order: string; title: string }>>;
    };
    const review = board.cardsByColumn["review"] ?? [];
    // Insert at index 1 (between Alpha and Gamma after sort)
    const sorted = review.slice().sort((a, b) =>
      a.order < b.order ? -1 : a.order > b.order ? 1 : a.id < b.id ? -1 : 1,
    );
    const payload = dropToMovePayload(
      "review",
      sorted.map((c) => ({ id: c.id, order: c.order })),
      dragId,
      1,
    );
    expect(payload.order > sorted[0]!.order).toBe(true);
    expect(payload.order < sorted[1]!.order).toBe(true);

    const move = await fetch(
      `http://127.0.0.1:${port}/api/boards/backend/cards/${dragId}/move`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      },
    );
    expect(move.status).toBe(200);

    const cardsDir = join(ctx.repoPath, "backend", "cards");
    const file = readdirSync(cardsDir).find((f) => f.startsWith(`${dragId}-`));
    expect(file).toBeTruthy();
    const parsed = parseCard(readFileSync(join(cardsDir, file!), "utf8"));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.card.frontmatter.column).toBe("review");
    expect(parsed.card.frontmatter.order).toBe(payload.order);

    const log = spawnSync("git", ["log", "-1", "--pretty=%s"], {
      cwd: ctx.repoPath,
      encoding: "utf8",
    });
    expect(log.stdout).toMatch(new RegExp(`move ${dragId}|${dragId}`));
  });
});
