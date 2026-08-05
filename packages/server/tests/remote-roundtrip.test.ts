/**
 * Full remote round-trip against a real bare git remote (no network / PAT).
 *
 * Covers: connect → create board → create cards → patch → move → push →
 * second clone pull → assert parity → sync label clean.
 */
import { describe, expect, test, afterEach } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { connectLocalRepo } from "../src/connect.ts";
import { BoardIndexStore } from "../src/index-store.ts";
import { startServer } from "../src/app.ts";
import { freePort, makeBareRemotePair, git } from "./helpers.ts";

describe("remote round-trip (bare origin)", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  test("create → push → second clone sees cards; long ids; sync drains", async () => {
    const pair = makeBareRemotePair();
    cleanups.push(pair.cleanup);

    // Ensure origin on working clone
    git(pair.clone, ["remote", "remove", "origin"]);
    git(pair.clone, ["remote", "add", "origin", pair.bare]);
    git(pair.clone, ["push", "-u", "origin", "main"]);

    const store = new BoardIndexStore();
    const connected = await connectLocalRepo(pair.clone, {
      indexStore: store,
      scaffold: true,
    });
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
    const base = `http://127.0.0.1:${port}`;

    // 1) Health
    const health = await (await fetch(`${base}/health`)).json() as {
      ok: boolean;
    };
    expect(health.ok).toBe(true);

    // 2) Create board with long id
    const boardRes = await fetch(`${base}/api/boards`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Round Trip Board" }),
    });
    expect(boardRes.status).toBe(201);
    const boardBody = (await boardRes.json()) as {
      ok: boolean;
      boardId: string;
    };
    expect(boardBody.boardId).toMatch(/^b-[0-9a-f]{24}$/);
    const boardId = boardBody.boardId;

    // 3) Create cards
    const titles = [
      "Round-trip card alpha",
      "Round-trip card beta",
      "Round-trip card gamma",
    ];
    const cardIds: string[] = [];
    for (const title of titles) {
      const r = await fetch(`${base}/api/boards/${boardId}/cards`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title, column: "backlog" }),
      });
      expect(r.status).toBe(201);
      const j = (await r.json()) as { card: { id: string } };
      expect(j.card.id).toMatch(/^c-[0-9a-f]{24}$/);
      cardIds.push(j.card.id);
    }

    // 4) Patch first card
    const patch = await fetch(
      `${base}/api/boards/${boardId}/cards/${cardIds[0]}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          priority: "P0",
          labels: ["roundtrip", "ci"],
          assignee: "tester",
          status: "Patched during round-trip test.",
        }),
      },
    );
    expect(patch.ok).toBe(true);

    // 5) Move second card to doing
    const move = await fetch(
      `${base}/api/boards/${boardId}/cards/${cardIds[1]}/move`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ column: "doing" }),
      },
    );
    expect(move.ok).toBe(true);

    // 6) Sync should be pending, then flush
    let sync = (await (await fetch(`${base}/api/sync`)).json()) as {
      status: string;
      pendingCount: number;
    };
    expect(sync.pendingCount).toBeGreaterThan(0);

    const flushed = (await (
      await fetch(`${base}/api/sync/retry`, { method: "POST" })
    ).json()) as { status: string; pendingCount: number };
    expect(flushed.status).toBe("synced");
    expect(flushed.pendingCount).toBe(0);

    // 7) Second clone from bare remote — full parity
    const otherRoot = mkdtempSync(join(tmpdir(), "kanbanly-rt-clone-"));
    cleanups.push(() => {
      try {
        rmSync(otherRoot, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    });
    const other = join(otherRoot, "clone");
    const clone = spawnSync("git", ["clone", pair.bare, other], {
      encoding: "utf8",
    });
    expect(clone.status).toBe(0);

    const cardsDir = join(other, boardId, "cards");
    expect(existsSync(join(other, boardId, "board.yml"))).toBe(true);
    expect(existsSync(cardsDir)).toBe(true);
    const files = readdirSync(cardsDir).filter((f) => f.endsWith(".md"));
    expect(files.length).toBe(3);
    for (const id of cardIds) {
      expect(files.some((f) => f.startsWith(id))).toBe(true);
    }

    // 8) Second server on clone — pull path + list boards
    const store2 = new BoardIndexStore();
    const connected2 = await connectLocalRepo(other, { indexStore: store2 });
    const port2 = await freePort();
    const server2 = startServer({
      host: "127.0.0.1",
      port: port2,
      connected: connected2,
      indexStore: store2,
      enablePushQueue: false,
      startLive: false,
    });
    cleanups.push(() => server2.stop(true));

    const boards2 = (await (
      await fetch(`http://127.0.0.1:${port2}/api/boards`)
    ).json()) as { boards: Array<{ id: string; cardCount: number }> };
    const found = boards2.boards.find((b) => b.id === boardId);
    expect(found).toBeTruthy();
    expect(found!.cardCount).toBe(3);

    const detail = (await (
      await fetch(`http://127.0.0.1:${port2}/api/boards/${boardId}`)
    ).json()) as {
      cards: Array<{
        id: string;
        column: string;
        priority?: string;
        labels?: string[];
      }>;
    };
    const alpha = detail.cards.find((c) => c.id === cardIds[0]);
    expect(alpha?.priority).toBe("P0");
    expect(alpha?.labels).toContain("roundtrip");
    const beta = detail.cards.find((c) => c.id === cardIds[1]);
    expect(beta?.column).toBe("doing");

    // 9) Origin log has our commits
    const log = git(pair.bare, ["log", "--oneline"]);
    expect(log.stdout).toMatch(/Round-trip|create c-|create board/);
  });
});
