import { describe, expect, test } from "bun:test";
import {
  countFrontmatterKey,
  parseCard,
  serializeCard,
  type Card,
} from "../src/card.ts";
import { mergeCards, mergeCardTexts, mergeLog } from "../src/merge.ts";

function card(partial: {
  column: string;
  title?: string;
  updated: string;
  status?: string;
  log?: string[];
  order?: string;
}): Card {
  return {
    frontmatter: {
      id: "c-8f3a",
      title: partial.title ?? "Refactor auth",
      column: partial.column,
      order: partial.order ?? "m",
      updated: partial.updated,
      labels: [],
    },
    status: partial.status ?? "working",
    log: partial.log ?? ["2026-08-01 claude: created"],
  };
}

describe("mergeCards", () => {
  test("both moved column — higher updated wins", () => {
    const base = card({ column: "backlog", updated: "2026-08-01T00:00:00Z" });
    const ours = card({
      column: "doing",
      updated: "2026-08-04T10:00:00Z",
      status: "we started",
    });
    const theirs = card({
      column: "review",
      updated: "2026-08-04T12:00:00Z",
      status: "they reviewed",
    });
    const merged = mergeCards(base, ours, theirs);
    expect(merged.frontmatter.column).toBe("review");
    expect(merged.status).toBe("they reviewed");
    // Never duplicate-keyed when serialized
    const text = serializeCard(merged);
    expect(countFrontmatterKey(text, "column")).toBe(1);
  });

  test("both appended Log — union dedupe sort", () => {
    const base = card({
      column: "doing",
      updated: "2026-08-01T00:00:00Z",
      log: ["2026-08-01 claude: created"],
    });
    const ours = card({
      column: "doing",
      updated: "2026-08-03T00:00:00Z",
      log: [
        "2026-08-01 claude: created",
        "2026-08-02 claude: ours step",
      ],
    });
    const theirs = card({
      column: "doing",
      updated: "2026-08-03T00:00:00Z",
      log: [
        "2026-08-01 claude: created",
        "2026-08-02 agent: theirs step",
      ],
    });
    const merged = mergeCards(base, ours, theirs);
    expect(merged.log).toContain("2026-08-02 claude: ours step");
    expect(merged.log).toContain("2026-08-02 agent: theirs step");
    // dedupe
    expect(merged.log.filter((l) => l === "2026-08-01 claude: created").length).toBe(1);
  });

  test("mergeLog unions, dedupes, and re-sorts by date prefix", () => {
    // Deliberately out-of-order inputs across sides
    const result = mergeLog(
      ["2026-08-03 claude: ours late", "2026-08-01 claude: created"],
      ["2026-08-02 agent: theirs mid", "2026-08-01 claude: created"],
      ["2026-08-01 claude: created"],
    );
    expect(result).toEqual([
      "2026-08-01 claude: created",
      "2026-08-02 agent: theirs mid",
      "2026-08-03 claude: ours late",
    ]);
    // exact dedupe
    expect(result.filter((l) => l === "2026-08-01 claude: created").length).toBe(1);
  });

  test("one renamed title — higher updated wins", () => {
    const base = card({
      column: "doing",
      title: "Old title",
      updated: "2026-08-01T00:00:00Z",
    });
    const ours = card({
      column: "doing",
      title: "Old title",
      updated: "2026-08-02T00:00:00Z",
    });
    const theirs = card({
      column: "doing",
      title: "New title",
      updated: "2026-08-03T00:00:00Z",
    });
    const merged = mergeCards(base, ours, theirs);
    expect(merged.frontmatter.title).toBe("New title");
  });

  test("one archived (moved to done) — higher updated wins", () => {
    const base = card({ column: "review", updated: "2026-08-01T00:00:00Z" });
    const ours = card({ column: "review", updated: "2026-08-02T00:00:00Z" });
    const theirs = card({
      column: "done",
      updated: "2026-08-04T00:00:00Z",
      status: "shipped",
    });
    const merged = mergeCards(base, ours, theirs);
    expect(merged.frontmatter.column).toBe("done");
    expect(merged.status).toBe("shipped");
  });

  test("output is never duplicate-keyed YAML — single column: key", () => {
    const base = card({ column: "backlog", updated: "2026-08-01T00:00:00Z" });
    const ours = card({ column: "doing", updated: "2026-08-04T10:00:00Z" });
    const theirs = card({ column: "review", updated: "2026-08-04T11:00:00Z" });
    const text = mergeCardTexts(
      serializeCard(base),
      serializeCard(ours),
      serializeCard(theirs),
    );
    expect(countFrontmatterKey(text, "column")).toBe(1);
    expect(countFrontmatterKey(text, "title")).toBe(1);
    expect(countFrontmatterKey(text, "updated")).toBe(1);
    // And it parses cleanly
    const r = parseCard(text);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.card.frontmatter.column).toBe("review");
  });

  test("Status resolves by higher updated", () => {
    const base = card({
      column: "doing",
      updated: "2026-08-01T00:00:00Z",
      status: "base",
    });
    const ours = card({
      column: "doing",
      updated: "2026-08-05T00:00:00Z",
      status: "ours status",
    });
    const theirs = card({
      column: "doing",
      updated: "2026-08-03T00:00:00Z",
      status: "theirs status",
    });
    const merged = mergeCards(base, ours, theirs);
    expect(merged.status).toBe("ours status");
  });
});
