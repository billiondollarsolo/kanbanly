import { describe, expect, test } from "bun:test";
import {
  appendColumn,
  boardDisplayTitle,
  flagUnknownColumns,
  parseBoard,
  removeColumn,
  renameColumn,
  reorderColumns,
  serializeBoard,
  slugifyBoardId,
  slugifyColumnId,
} from "../src/board.ts";
import { generateBoardId } from "../src/id.ts";

const SAMPLE = `
columns:
  - id: backlog
    name: Backlog
  - id: doing
    name: Doing
  - id: done
    name: Done
labels:
  - backend
  - frontend
settings:
  wip: false
`;

describe("parseBoard", () => {
  test("returns columns, labels, settings", () => {
    const r = parseBoard(SAMPLE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.board.columns.map((c) => c.id)).toEqual(["backlog", "doing", "done"]);
    expect(r.board.columns[0]!.name).toBe("Backlog");
    expect(r.board.labels).toContain("backend");
    expect(r.board.settings).toEqual({ wip: false });
  });

  test("duplicate column ids return validation error", () => {
    const bad = `
columns:
  - id: doing
    name: Doing
  - id: doing
    name: Also Doing
`;
    const r = parseBoard(bad);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toMatch(/duplicate/i);
  });

  test("card with unknown column is flagged, not dropped", () => {
    const r = parseBoard(SAMPLE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const flagged = flagUnknownColumns(r.board, [
      { id: "c-1", column: "doing" },
      { id: "c-2", column: "qa" },
    ]);
    expect(flagged).toEqual([
      { id: "c-1", column: "doing", known: true },
      { id: "c-2", column: "qa", known: false },
    ]);
    expect(flagged.length).toBe(2); // not dropped
  });

  test("invalid YAML returns typed board_parse_error, never throws", () => {
    let threw = false;
    let r;
    try {
      r = parseBoard("columns: [unterminated");
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(r!.ok).toBe(false);
    if (r!.ok) return;
    expect(r!.error.kind).toBe("board_parse_error");
    expect(r!.error.message).toMatch(/invalid yaml/i);
  });
});

describe("appendColumn + serializeBoard", () => {
  test("slugifyColumnId from display name", () => {
    expect(slugifyColumnId("Blocked")).toBe("blocked");
    expect(slugifyColumnId("In Review")).toBe("in-review");
  });

  test("appendColumn adds id+name and round-trips YAML", () => {
    const base = parseBoard(SAMPLE);
    expect(base.ok).toBe(true);
    if (!base.ok) return;
    const next = appendColumn(base.board, { name: "Blocked" });
    expect(next.ok).toBe(true);
    if (!next.ok) return;
    expect(next.column).toEqual({ id: "blocked", name: "Blocked" });
    expect(next.board.columns.map((c) => c.id)).toEqual([
      "backlog",
      "doing",
      "done",
      "blocked",
    ]);
    const text = serializeBoard(next.board);
    const again = parseBoard(text);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.board.columns.at(-1)).toEqual({ id: "blocked", name: "Blocked" });
  });

  test("duplicate id auto-suffixes", () => {
    const base = parseBoard(SAMPLE);
    expect(base.ok).toBe(true);
    if (!base.ok) return;
    const next = appendColumn(base.board, { name: "Doing" });
    expect(next.ok).toBe(true);
    if (!next.ok) return;
    expect(next.column.id).toBe("doing-2");
  });

  test("blank name rejected", () => {
    const base = parseBoard(SAMPLE);
    expect(base.ok).toBe(true);
    if (!base.ok) return;
    const next = appendColumn(base.board, { name: "   " });
    expect(next.ok).toBe(false);
  });

  test("renameColumn changes name only", () => {
    const base = parseBoard(SAMPLE);
    expect(base.ok).toBe(true);
    if (!base.ok) return;
    const next = renameColumn(base.board, "doing", "In progress");
    expect(next.ok).toBe(true);
    if (!next.ok) return;
    expect(next.column).toEqual({ id: "doing", name: "In progress" });
    expect(next.board.columns.find((c) => c.id === "doing")?.name).toBe(
      "In progress",
    );
  });

  test("reorderColumns permutes order", () => {
    const base = parseBoard(SAMPLE);
    expect(base.ok).toBe(true);
    if (!base.ok) return;
    const next = reorderColumns(base.board, ["done", "backlog", "doing"]);
    expect(next.ok).toBe(true);
    if (!next.ok) return;
    expect(next.board.columns.map((c) => c.id)).toEqual([
      "done",
      "backlog",
      "doing",
    ]);
  });

  test("removeColumn refuses last column", () => {
    const one = parseBoard(`columns:\n  - id: only\n    name: Only\n`);
    expect(one.ok).toBe(true);
    if (!one.ok) return;
    expect(removeColumn(one.board, "only").ok).toBe(false);

    const base = parseBoard(SAMPLE);
    expect(base.ok).toBe(true);
    if (!base.ok) return;
    const next = removeColumn(base.board, "doing");
    expect(next.ok).toBe(true);
    if (!next.ok) return;
    expect(next.board.columns.map((c) => c.id)).toEqual(["backlog", "done"]);
  });

  test("slugifyBoardId", () => {
    expect(slugifyBoardId("Mobile App")).toBe("mobile-app");
  });

  test("generateBoardId is unique b- + 24 hex (Trello-style)", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const id = generateBoardId(ids);
      expect(id).toMatch(/^b-[0-9a-f]{24}$/);
      ids.add(id);
    }
    expect(ids.size).toBe(20);
  });

  test("boardDisplayTitle prefers title", () => {
    expect(boardDisplayTitle({ title: "Mobile", id: "b-1" }, "x")).toBe(
      "Mobile",
    );
    expect(boardDisplayTitle({}, "backend")).toBe("backend");
  });

  test("serializeBoard includes title + id", () => {
    const text = serializeBoard({
      id: "b-abc12",
      title: "Mobile",
      columns: [{ id: "todo", name: "Todo" }],
      labels: [],
      settings: {},
    });
    const again = parseBoard(text);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.board.id).toBe("b-abc12");
    expect(again.board.title).toBe("Mobile");
  });
});
