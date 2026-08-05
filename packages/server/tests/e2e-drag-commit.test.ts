/**
 * E2E-style: real browser is optional; this drives the shipped write path
 * exactly as a drag does (dropToMovePayload → POST move) and asserts:
 *  1) card lands in target column on the API
 *  2) a git commit exists for the move
 *
 * Full Playwright UI drag lives behind `bun run test:e2e` when Playwright
 * browsers are installed (see e2e/playwright.config.ts).
 */
import { describe, expect, test, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dropToMovePayload } from "@kanbanly/core";
import { connectLocalRepo } from "../src/connect.ts";
import { BoardIndexStore } from "../src/index-store.ts";
import { startServer } from "../src/app.ts";
import { freePort, makeTempRepoFromFixture, git } from "./helpers.ts";

describe("e2e drag → move → commit (US-17/18)", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  test("drop payload + POST move updates column and creates git commit", async () => {
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

    // Fixture: c-a1b2 in backlog. Drag to end of doing (after c-c3d4).
    const boardRes = await fetch(`http://127.0.0.1:${port}/api/boards/backend`);
    const board = (await boardRes.json()) as {
      cardsByColumn: Record<string, Array<{ id: string; order: string; column: string }>>;
      cards: Array<{ id: string; column: string }>;
    };
    const doing = board.cardsByColumn["doing"] ?? [];
    const payload = dropToMovePayload(
      "doing",
      doing.map((c) => ({ id: c.id, order: c.order })),
      "c-a1b2",
      doing.length, // after last
    );

    const beforeLog = git(ctx.repoPath, ["log", "--oneline"]).stdout;

    const moveRes = await fetch(
      `http://127.0.0.1:${port}/api/boards/backend/cards/c-a1b2/move`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      },
    );
    expect(moveRes.status).toBe(200);
    const moved = (await moveRes.json()) as { ok: boolean; column: string; sha?: string };
    expect(moved.ok).toBe(true);
    expect(moved.column).toBe("doing");
    expect(moved.sha).toBeTruthy();

    // Board API reflects landing column
    const after = await fetch(`http://127.0.0.1:${port}/api/boards/backend`);
    const afterBody = (await after.json()) as {
      cards: Array<{ id: string; column: string }>;
    };
    const card = afterBody.cards.find((c) => c.id === "c-a1b2");
    expect(card?.column).toBe("doing");

    // Git commit exists after the drag
    const afterLog = git(ctx.repoPath, ["log", "--oneline"]).stdout;
    expect(afterLog).not.toBe(beforeLog);
    expect(afterLog).toMatch(/move c-a1b2|chore\(board\): move/i);

    // File on disk updated
    const files = git(ctx.repoPath, [
      "ls-files",
      "backend/cards/c-a1b2-*.md",
    ]).stdout.trim();
    // ls-files may need pathspec without glob via find
    const cardPath = join(
      ctx.repoPath,
      "backend/cards",
      // discover actual filename
      ...[],
    );
    void cardPath;
    const listed = git(ctx.repoPath, ["ls-files", "backend/cards"]).stdout
      .split("\n")
      .find((l) => l.includes("c-a1b2"));
    expect(listed).toBeTruthy();
    const text = readFileSync(join(ctx.repoPath, listed!), "utf8");
    expect(text).toMatch(/^column:\s*doing/m);
    expect(text).toMatch(/moved backlog → doing/);
  });
});
