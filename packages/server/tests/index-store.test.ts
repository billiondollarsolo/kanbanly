import { describe, expect, test, afterEach } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { GitStorage } from "@kanbanly/core";
import { BoardIndexStore } from "../src/index-store.ts";
import { makeTempRepoFromFixture, git } from "./helpers.ts";

describe("BoardIndexStore (SHA-keyed, parse counter)", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  test("rebuild indexes layout A boards and sorts cards by order per column", async () => {
    const ctx = makeTempRepoFromFixture();
    cleanups.push(ctx.cleanup);

    const storage = new GitStorage({ repoPath: ctx.repoPath });
    const store = new BoardIndexStore();
    const index = await store.rebuild("local", storage);

    expect(index.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(index.boards.map((b) => b.id).sort()).toEqual(["backend", "web"]);

    const backend = index.boards.find((b) => b.id === "backend")!;
    expect(backend).toBeDefined();
    expect(backend.board.columns.map((c) => c.id)).toEqual([
      "backlog",
      "doing",
      "review",
      "done",
    ]);

    // Fixture cards: c-a1b2 in backlog, c-c3d4 in doing
    expect(backend.cardsByColumn["backlog"]!.map((c) => c.id)).toEqual(["c-a1b2"]);
    expect(backend.cardsByColumn["doing"]!.map((c) => c.id)).toEqual(["c-c3d4"]);
    expect(backend.cardsByColumn["backlog"]![0]!.title).toBe("Setup auth middleware");
    expect(backend.cardsByColumn["doing"]![0]!.title).toBe("Wire up rate limiter");

    // web board has no cards
    const web = index.boards.find((b) => b.id === "web")!;
    expect(web.cards.length).toBe(0);
  });

  test("unchanged SHA performs zero additional parse work", async () => {
    const ctx = makeTempRepoFromFixture();
    cleanups.push(ctx.cleanup);

    const storage = new GitStorage({ repoPath: ctx.repoPath });
    const store = new BoardIndexStore();

    await store.ensure("local", storage);
    const afterFirst = store.parseCallCount;
    expect(afterFirst).toBeGreaterThan(0);
    expect(store.rebuildCount).toBe(1);

    // Second ensure with same SHA — no rebuild
    const r2 = await store.ensure("local", storage);
    expect(r2.rebuilt).toBe(false);
    expect(store.parseCallCount).toBe(afterFirst);
    expect(store.rebuildCount).toBe(1);

    // Third call still zero work
    await store.ensure("local", storage);
    expect(store.parseCallCount).toBe(afterFirst);
    expect(store.rebuildCount).toBe(1);
  });

  test("new SHA triggers a full re-parse", async () => {
    const ctx = makeTempRepoFromFixture();
    cleanups.push(ctx.cleanup);

    const storage = new GitStorage({ repoPath: ctx.repoPath });
    const store = new BoardIndexStore();

    await store.ensure("local", storage);
    const afterFirst = store.parseCallCount;
    const firstSha = store.get("local")!.sha;

    // Mutate repo and commit so SHA changes
    writeFileSync(join(ctx.repoPath, "README.md"), "# boards\n");
    git(ctx.repoPath, ["add", "README.md"]);
    git(ctx.repoPath, ["commit", "-m", "touch readme"]);

    const r2 = await store.ensure("local", storage);
    expect(r2.rebuilt).toBe(true);
    expect(store.parseCallCount).toBeGreaterThan(afterFirst);
    expect(store.rebuildCount).toBe(2);
    expect(store.get("local")!.sha).not.toBe(firstSha);
  });
});
