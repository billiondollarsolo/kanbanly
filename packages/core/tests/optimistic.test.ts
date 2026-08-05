import { describe, expect, test } from "bun:test";
import {
  applyOptimisticCreate,
  applyOptimisticMove,
  type OptimisticBoard,
} from "../src/optimistic.ts";

function sampleBoard(): OptimisticBoard {
  return {
    id: "backend",
    path: "backend",
    columns: [
      { id: "backlog", name: "Backlog" },
      { id: "doing", name: "Doing" },
    ],
    labels: [],
    settings: {},
    cards: [
      { id: "c-a", title: "A", column: "backlog", order: "a0" },
      { id: "c-b", title: "B", column: "backlog", order: "a1" },
      { id: "c-c", title: "C", column: "doing", order: "a0" },
    ],
    cardsByColumn: {
      backlog: [
        { id: "c-a", title: "A", column: "backlog", order: "a0" },
        { id: "c-b", title: "B", column: "backlog", order: "a1" },
      ],
      doing: [{ id: "c-c", title: "C", column: "doing", order: "a0" }],
    },
  };
}

describe("applyOptimisticMove", () => {
  test("moves card to new column and order immediately", () => {
    const next = applyOptimisticMove(sampleBoard(), "c-a", "doing", "a5");
    expect(next.cards.find((c) => c.id === "c-a")?.column).toBe("doing");
    expect(next.cards.find((c) => c.id === "c-a")?.order).toBe("a5");
    expect(next.cardsByColumn.backlog?.some((c) => c.id === "c-a")).toBe(false);
    expect(next.cardsByColumn.doing?.some((c) => c.id === "c-a")).toBe(true);
  });

  test("does not mutate original board", () => {
    const board = sampleBoard();
    const snap = JSON.stringify(board);
    applyOptimisticMove(board, "c-a", "doing", "z");
    expect(JSON.stringify(board)).toBe(snap);
  });
});

describe("applyOptimisticCreate", () => {
  test("inserts new card into column group", () => {
    const next = applyOptimisticCreate(sampleBoard(), {
      id: "c-new",
      title: "New",
      column: "backlog",
      order: "a2",
    });
    expect(next.cards.some((c) => c.id === "c-new")).toBe(true);
    expect(next.cardsByColumn.backlog?.map((c) => c.id)).toContain("c-new");
  });
});
