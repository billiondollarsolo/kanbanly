import { describe, expect, test } from "bun:test";
import {
  filterCards,
  cardMatchesFilter,
  isFilterActive,
  filteredColumnCounts,
} from "../src/filter.ts";

const cards = [
  {
    id: "c-1",
    title: "Auth middleware",
    column: "doing",
    labels: ["backend", "security"],
    assignee: "claude",
    status: "working",
  },
  {
    id: "c-2",
    title: "Landing page",
    column: "backlog",
    labels: ["frontend"],
    assignee: "human",
    status: "todo",
  },
  {
    id: "c-3",
    title: "Rate limit",
    column: "doing",
    labels: ["backend"],
    status: "sketch",
  },
];

describe("filterCards", () => {
  test("filters by free text on title", () => {
    const r = filterCards(cards, { query: "auth" });
    expect(r.map((c) => c.id)).toEqual(["c-1"]);
  });

  test("filters by label", () => {
    const r = filterCards(cards, { label: "backend" });
    expect(r.map((c) => c.id).sort()).toEqual(["c-1", "c-3"]);
  });

  test("filters by assignee", () => {
    const r = filterCards(cards, { assignee: "human" });
    expect(r.map((c) => c.id)).toEqual(["c-2"]);
  });

  test("combines query + column", () => {
    expect(cardMatchesFilter(cards[0]!, { query: "rate", column: "doing" })).toBe(
      false,
    );
    expect(cardMatchesFilter(cards[2]!, { query: "rate", column: "doing" })).toBe(
      true,
    );
  });

  test("multi-label OR within type", () => {
    const r = filterCards(cards, { labels: ["frontend", "security"] });
    expect(r.map((c) => c.id).sort()).toEqual(["c-1", "c-2"]);
  });

  test("AND across types with OR labels", () => {
    const r = filterCards(cards, {
      labels: ["backend", "frontend"],
      column: "doing",
    });
    expect(r.map((c) => c.id).sort()).toEqual(["c-1", "c-3"]);
  });

  test("isFilterActive + filteredColumnCounts", () => {
    expect(isFilterActive({})).toBe(false);
    expect(isFilterActive({ query: "x" })).toBe(true);
    const byCol = {
      doing: [cards[0]!, cards[2]!],
      backlog: [cards[1]!],
    };
    const counts = filteredColumnCounts(byCol, { label: "backend" });
    expect(counts.doing).toBe(2);
    expect(counts.backlog).toBe(0);
  });
});
