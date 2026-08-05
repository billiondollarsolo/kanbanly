import { describe, expect, test, afterEach } from "bun:test";
import { connectLocalRepo } from "../src/connect.ts";
import { BoardIndexStore } from "../src/index-store.ts";
import { makeTempRepoFromFixture } from "./helpers.ts";

describe("connectLocalRepo + load layout A", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  test("loads fixture layout A and exposes columns + sorted cards", async () => {
    const ctx = makeTempRepoFromFixture();
    cleanups.push(ctx.cleanup);

    const store = new BoardIndexStore();
    const connected = await connectLocalRepo(ctx.repoPath, { indexStore: store });

    expect(connected.path).toBe(ctx.repoPath);
    expect(connected.storage.repoPath).toBe(ctx.repoPath);
    expect(connected.index.boards.length).toBe(2);

    const backend = connected.index.boards.find((b) => b.id === "backend");
    expect(backend).toBeDefined();
    if (!backend) return;

    // Columns from board.yml
    const colIds = backend.board.columns.map((c) => c.id);
    expect(colIds).toEqual(["backlog", "doing", "review", "done"]);

    // Cards sorted by order within each column
    const backlog = backend.cardsByColumn["backlog"] ?? [];
    const doing = backend.cardsByColumn["doing"] ?? [];
    expect(backlog.length).toBe(1);
    expect(doing.length).toBe(1);
    expect(backlog[0]!.title).toBe("Setup auth middleware");
    expect(doing[0]!.title).toBe("Wire up rate limiter");

    // Flat cards list includes both
    expect(backend.cards.map((c) => c.id).sort()).toEqual(["c-a1b2", "c-c3d4"]);
  });

  test("rejects non-git paths", async () => {
    const ctx = makeTempRepoFromFixture();
    cleanups.push(ctx.cleanup);
    await expect(connectLocalRepo("/tmp/definitely-not-a-kanbanly-repo-xyz")).rejects.toThrow();
  });
});
