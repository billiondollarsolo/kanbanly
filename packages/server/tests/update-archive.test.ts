/**
 * Card update + archive via shipped GitStorage + HTTP (real git).
 */
import { describe, expect, test, afterEach } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { parseCard } from "@kanbanly/core";
import { connectLocalRepo } from "../src/connect.ts";
import { BoardIndexStore } from "../src/index-store.ts";
import { startServer } from "../src/app.ts";
import { freePort, makeTempRepoFromFixture, makeEmptyLayoutARepo } from "./helpers.ts";

describe("update card + archive (real git)", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  test("PATCH updates status/title on disk and commits", async () => {
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
      `http://127.0.0.1:${port}/api/boards/backend/cards/c-a1b2`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Auth middleware v2",
          status: "Validated sessions green.",
          assignee: "human",
          labels: ["backend", "security", "mvp"],
        }),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      card: { title: string; status: string; assignee?: string };
      sha: string;
    };
    expect(body.ok).toBe(true);
    expect(body.card.title).toBe("Auth middleware v2");
    expect(body.card.status).toContain("Validated");
    expect(body.card.assignee).toBe("human");

    const cardsDir = join(ctx.repoPath, "backend", "cards");
    const file = readdirSync(cardsDir).find((f) => f.startsWith("c-a1b2-"));
    expect(file).toBeTruthy();
    const parsed = parseCard(readFileSync(join(cardsDir, file!), "utf8"));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.card.frontmatter.title).toBe("Auth middleware v2");
    expect(parsed.card.status).toContain("Validated");
    expect(parsed.card.log.some((l) => l.includes("updated"))).toBe(true);

    const log = spawnSync("git", ["log", "-1", "--pretty=%s"], {
      cwd: ctx.repoPath,
      encoding: "utf8",
    });
    expect(log.stdout).toMatch(/update c-a1b2/);
  });

  test("archive moves done cards to cards/archive via git mv commit", async () => {
    const ctx = makeEmptyLayoutARepo();
    cleanups.push(ctx.cleanup);
    const store = new BoardIndexStore();
    const connected = await connectLocalRepo(ctx.repoPath, { indexStore: store });

    // Create 3 done cards via storage
    for (let i = 0; i < 3; i++) {
      await connected.storage.createCard(
        "backend",
        `Done ${i}`,
        "done",
        `a${i}`,
      );
    }

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

    // List done cards
    const board = await fetch(`http://127.0.0.1:${port}/api/boards/backend`);
    const detail = (await board.json()) as {
      cardsByColumn: Record<string, Array<{ id: string }>>;
    };
    const doneIds = (detail.cardsByColumn.done ?? []).map((c) => c.id);
    expect(doneIds.length).toBe(3);

    // Archive 2 of them
    const toArch = doneIds.slice(0, 2);
    const arch = await fetch(
      `http://127.0.0.1:${port}/api/boards/backend/archive`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cardIds: toArch }),
      },
    );
    expect(arch.status).toBe(200);
    const archBody = (await arch.json()) as { archived: string[] };
    expect(archBody.archived.length).toBe(2);

    const archiveDir = join(ctx.repoPath, "backend", "cards", "archive");
    expect(existsSync(archiveDir)).toBe(true);
    const archivedFiles = readdirSync(archiveDir).filter((f) => f.endsWith(".md"));
    expect(archivedFiles.length).toBe(2);

    // Index no longer lists archived
    const board2 = await fetch(`http://127.0.0.1:${port}/api/boards/backend`);
    const detail2 = (await board2.json()) as {
      cardsByColumn: Record<string, Array<{ id: string }>>;
      cards: Array<{ id: string }>;
    };
    expect(detail2.cardsByColumn.done?.length ?? 0).toBe(1);
    for (const id of toArch) {
      expect(detail2.cards.some((c) => c.id === id)).toBe(false);
    }

    const log = spawnSync("git", ["log", "-1", "--pretty=%s"], {
      cwd: ctx.repoPath,
      encoding: "utf8",
    });
    expect(log.stdout).toMatch(/archive/);
  });

  test("olderThanKeep archives done cards beyond N most recent", async () => {
    const ctx = makeEmptyLayoutARepo();
    cleanups.push(ctx.cleanup);
    const store = new BoardIndexStore();
    const connected = await connectLocalRepo(ctx.repoPath, { indexStore: store });
    for (let i = 0; i < 5; i++) {
      await connected.storage.createCard("backend", `Old ${i}`, "done", `b${i}`);
    }
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
      `http://127.0.0.1:${port}/api/boards/backend/archive`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ olderThanKeep: 2 }),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { archived: string[] };
    expect(body.archived.length).toBe(3);

    const board = await fetch(`http://127.0.0.1:${port}/api/boards/backend`);
    const detail = (await board.json()) as {
      cardsByColumn: Record<string, unknown[]>;
    };
    expect(detail.cardsByColumn.done?.length).toBe(2);
  });
});
