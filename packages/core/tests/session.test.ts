import { describe, expect, test } from "bun:test";
import {
  applySessionEnd,
  buildSessionStartBrief,
  canAgentPickup,
  checkDoingWip,
  extractCardIdsFromText,
  formatSessionStartBrief,
  isAgentPickupColumn,
} from "../src/session.ts";
import { defaultBoardYaml, DEFAULT_PROJECT_COLUMNS, parseBoard } from "../src/board.ts";
import type { Card } from "../src/card.ts";

function card(column: string, assignee?: string): Card {
  return {
    frontmatter: {
      id: "c-abc",
      title: "Work",
      column,
      order: "a0",
      updated: "2026-08-05T00:00:00Z",
      assignee,
      labels: [],
    },
    status: "_Not started._",
    log: ["2026-08-05 human: created"],
  };
}

describe("session / agent pickup", () => {
  test("default project columns include Ready and WIP settings", () => {
    const yml = defaultBoardYaml({ title: "App", id: "b-1" });
    const parsed = parseBoard(yml);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.board.columns.map((c) => c.id)).toEqual(
      DEFAULT_PROJECT_COLUMNS.map((c) => c.id),
    );
    expect(parsed.board.settings?.wipDoing).toBe(3);
    expect(parsed.board.settings?.agentPickup).toEqual(["ready", "doing"]);
  });

  test("isAgentPickupColumn", () => {
    expect(isAgentPickupColumn("ready")).toBe(true);
    expect(isAgentPickupColumn("doing")).toBe(true);
    expect(isAgentPickupColumn("inbox")).toBe(false);
  });

  test("canAgentPickup Ready always; Doing only if assignee matches", () => {
    expect(canAgentPickup(card("ready"), "claude").ok).toBe(true);
    expect(canAgentPickup(card("doing"), "claude").ok).toBe(true);
    expect(canAgentPickup(card("doing", "claude"), "claude").ok).toBe(true);
    expect(canAgentPickup(card("doing", "other"), "claude").ok).toBe(false);
    expect(canAgentPickup(card("inbox"), "claude").ok).toBe(false);
  });

  test("applySessionEnd appends log and optional sha/status", () => {
    const r = applySessionEnd({
      card: card("doing", "claude"),
      summary: "shipped auth",
      actor: "claude",
      sha: "a1b2c3d4e5",
      status: "Auth merged.",
      date: "2026-08-05",
    });
    expect(r.logLine).toContain("session-end");
    expect(r.logLine).toContain("a1b2c3d4e5");
    expect(r.card.log.at(-1)).toBe(r.logLine);
    expect(r.card.status).toBe("Auth merged.");
    expect(r.markdown).toContain("## Log");
  });

  test("extractCardIdsFromText finds long and short ids", () => {
    expect(
      extractCardIdsFromText("fix c-a1b2 and c-deadbeef0011223344556677 done"),
    ).toEqual(["c-a1b2", "c-deadbeef0011223344556677"]);
  });

  test("checkDoingWip soft limit", () => {
    expect(checkDoingWip(2, { wipDoing: 3 }).over).toBe(false);
    expect(checkDoingWip(3, { wipDoing: 3 }, { movingIntoDoing: true }).over).toBe(
      true,
    );
  });

  test("session-start brief formats ready + commits", () => {
    const brief = buildSessionStartBrief({
      boardId: "b-1",
      boardTitle: "App",
      notesBody: "# Intent\nShip fast.\n",
      cards: [
        { id: "c-1", title: "A", column: "ready", priority: "P0" },
        { id: "c-2", title: "B", column: "doing", assignee: "claude" },
      ],
      commits: [
        {
          sha: "abcdef012345",
          date: "2026-08-05T00:00:00Z",
          author: "dev",
          subject: "feat: thing c-1",
        },
      ],
      settings: { wipDoing: 3 },
      actor: "claude",
    });
    expect(brief.readyCards).toHaveLength(1);
    expect(brief.pickupHint).toMatch(/Ready/);
    const text = formatSessionStartBrief(brief);
    expect(text).toContain("Session start");
    expect(text).toContain("c-1");
    expect(text).toContain("abcdef0");
  });
});
