import { describe, expect, test } from "bun:test";
import { flagUnknownColumns, parseBoard } from "../src/board.ts";

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
