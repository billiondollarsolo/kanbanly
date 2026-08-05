import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { serializeCard, type Card } from "@kanbanly/core";
import { connectLocalRepo } from "../src/connect.ts";
import { BoardIndexStore } from "../src/index-store.ts";

function makeCard(i: number, column: string): Card {
  const id = `c-${i.toString(36).padStart(4, "0")}`;
  return {
    frontmatter: {
      id,
      title: `Card ${i}`,
      column,
      order: `a${i.toString(36)}`,
      updated: "2026-08-04T00:00:00Z",
      labels: i % 3 === 0 ? ["bench"] : [],
      assignee: i % 5 === 0 ? "alice" : undefined,
    },
    status: `_Item ${i}_ — **ready**`,
    log: [`2026-08-01 human: created ${i}`],
  };
}

describe("index benchmark (US-13)", () => {
  test("2000 cards re-index under 500ms; unchanged SHA is zero parse work", async () => {
    const root = mkdtempSync(join(tmpdir(), "kanbanly-bench-"));
    const repo = join(root, "boards");
    mkdirSync(join(repo, "backend", "cards"), { recursive: true });
    writeFileSync(
      join(repo, "backend", "board.yml"),
      `columns:
  - id: backlog
    name: Backlog
  - id: doing
    name: Doing
  - id: review
    name: Review
  - id: done
    name: Done
`,
    );

    const columns = ["backlog", "doing", "review", "done"];
    for (let i = 0; i < 2000; i++) {
      const card = makeCard(i, columns[i % columns.length]!);
      const fn = `${card.frontmatter.id}-card-${i}.md`;
      writeFileSync(
        join(repo, "backend", "cards", fn),
        serializeCard(card),
      );
    }

    spawnSync("git", ["init"], { cwd: repo });
    spawnSync("git", ["config", "user.name", "bench"], { cwd: repo });
    spawnSync("git", ["config", "user.email", "bench@t"], { cwd: repo });
    spawnSync("git", ["checkout", "-b", "main"], { cwd: repo });
    spawnSync("git", ["add", "."], { cwd: repo });
    spawnSync("git", ["commit", "-m", "bench 2000"], { cwd: repo });

    try {
      const store = new BoardIndexStore();
      // Warm path: open storage once, measure pure rebuild only
      const connected = await connectLocalRepo(repo, {
        indexStore: new BoardIndexStore(), // throwaway first index
        scaffold: false,
      });
      store.resetCounters();
      const t0 = performance.now();
      const index = await store.rebuild(connected.remoteKey, connected.storage);
      const t1 = performance.now();
      const reindexMs = t1 - t0;

      expect(index.cards.length).toBe(2000);
      // US-13: 2,000 cards re-index in under 500ms
      expect(reindexMs).toBeLessThan(500);

      // Unchanged SHA: zero additional parse work
      const afterFirst = store.parseCallCount;
      expect(afterFirst).toBeGreaterThan(0);
      const r2 = await store.ensure(connected.remoteKey, connected.storage);
      expect(r2.rebuilt).toBe(false);
      expect(store.parseCallCount).toBe(afterFirst);

      // Soft render-from-index bound: grouping 2000 cards < 100ms
      const board = store.getBoard(connected.remoteKey, "backend");
      expect(board).toBeTruthy();
      const t2 = performance.now();
      const byCol = board!.cards.reduce(
        (acc, c) => {
          (acc[c.column] ??= []).push(c);
          return acc;
        },
        {} as Record<string, typeof board.cards>,
      );
      const t3 = performance.now();
      expect(Object.keys(byCol).length).toBeGreaterThan(0);
      expect(t3 - t2).toBeLessThan(100);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
