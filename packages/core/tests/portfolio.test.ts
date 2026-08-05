import { describe, expect, test } from "bun:test";
import {
  buildPortfolio,
  buildPortfolioTile,
  countCommitsInWindow,
  formatPulseAge,
  githubCommitUrl,
  isBlockedColumn,
  isDoingColumn,
} from "../src/portfolio.ts";

describe("portfolio", () => {
  test("column helpers", () => {
    expect(isDoingColumn("doing")).toBe(true);
    expect(isDoingColumn("today")).toBe(true);
    expect(isBlockedColumn("blocked")).toBe(true);
    expect(isBlockedColumn("waiting")).toBe(true);
  });

  test("buildPortfolioTile counts P0, doing, stale, code binding", () => {
    const now = Date.parse("2026-08-05T12:00:00Z");
    const tile = buildPortfolioTile(
      {
        id: "b-1",
        title: "App",
        columns: [
          { id: "backlog", name: "Backlog" },
          { id: "doing", name: "Doing" },
          { id: "blocked", name: "Blocked" },
        ],
        cards: [
          {
            id: "c-1",
            title: "Hot",
            column: "doing",
            priority: "P0",
            updated: "2026-08-01T00:00:00Z",
            log: ["2026-08-01 claude: started"],
          },
          {
            id: "c-2",
            title: "Wait",
            column: "blocked",
            updated: "2026-08-05T10:00:00Z",
            log: ["2026-08-05 human: blocked on legal"],
          },
        ],
        settings: { code: { remote: "https://github.com/you/app.git" } },
      },
      { nowMs: now, staleHours: 48 },
    );
    expect(tile.p0Count).toBe(1);
    expect(tile.doingCount).toBe(1);
    expect(tile.blockedCount).toBe(1);
    expect(tile.staleDoingCount).toBe(1);
    expect(tile.codeBound).toBe(true);
    expect(tile.lastAgent).toBe("claude");
    expect(tile.columnCounts.doing).toBe(1);
    expect(tile.wipDoing.count).toBe(1);
    expect(tile.wipDoing.limit).toBe(3);
    expect(tile.health).toBe("stale");
    // Pulse = hours since max card.updated (blocked card at 10:00 → ~2h)
    expect(tile.velocity.pulseAgeHours).toBe(2);
    expect(tile.velocity.windowDays).toBe(7);
  });

  test("velocity counts done in window and log events", () => {
    const now = Date.parse("2026-08-05T12:00:00Z");
    const tile = buildPortfolioTile(
      {
        id: "b-v",
        title: "Vel",
        columns: [
          { id: "done", name: "Done" },
          { id: "doing", name: "Doing" },
        ],
        cards: [
          {
            id: "c-d",
            title: "Shipped",
            column: "done",
            updated: "2026-08-04T00:00:00Z",
            log: [
              "2026-08-04 agent: session-end — done",
              "2026-08-03 agent: working",
            ],
          },
          {
            id: "c-x",
            title: "Active",
            column: "doing",
            updated: "2026-08-05T10:00:00Z",
            log: ["2026-08-05 agent: pulse"],
          },
        ],
        // Code commits only surface when project source is bound
        settings: { code: { remote: "https://github.com/you/app.git" } },
        codeCommits7d: 12,
        codeCommits24h: 3,
      },
      { nowMs: now },
    );
    expect(tile.velocity.done7d).toBe(1);
    expect(tile.velocity.agentEvents7d).toBeGreaterThanOrEqual(2);
    expect(tile.codeBound).toBe(true);
    expect(tile.velocity.codeCommits7d).toBe(12);
    expect(tile.velocity.codeCommits24h).toBe(3);
    expect(tile.health).toBe("busy");
  });

  test("unbound boards hide code commit counts", () => {
    const tile = buildPortfolioTile({
      id: "b-u",
      title: "Unbound",
      columns: [{ id: "backlog", name: "B" }],
      cards: [],
      codeCommits7d: 99,
      codeCommits24h: 9,
    });
    expect(tile.codeBound).toBe(false);
    expect(tile.velocity.codeCommits7d).toBeNull();
    expect(tile.velocity.codeCommits24h).toBeNull();
    expect(tile.health).toBe("idle");
  });

  test("countCommitsInWindow and formatPulseAge", () => {
    const now = Date.parse("2026-08-05T12:00:00Z");
    expect(
      countCommitsInWindow(
        [
          { date: "2026-08-05T01:00:00Z" },
          { date: "2026-07-01T00:00:00Z" },
        ],
        7,
        now,
      ),
    ).toBe(1);
    expect(formatPulseAge(2)).toBe("2h ago");
    expect(formatPulseAge(72)).toBe("3d ago");
  });

  test("buildPortfolio sorts P0 first and merges activity", () => {
    const { tiles, activity, p0Total } = buildPortfolio([
      {
        id: "quiet",
        title: "Quiet",
        columns: [{ id: "backlog", name: "B" }],
        cards: [
          {
            id: "c-q",
            title: "Later",
            column: "backlog",
            updated: "2026-07-01T00:00:00Z",
            log: ["2026-07-01 human: created"],
          },
        ],
      },
      {
        id: "hot",
        title: "Hot",
        columns: [{ id: "doing", name: "D" }],
        cards: [
          {
            id: "c-h",
            title: "Fire",
            column: "doing",
            priority: "P0",
            updated: "2026-08-05T00:00:00Z",
            log: ["2026-08-05 agent: working"],
          },
        ],
      },
    ]);
    expect(tiles[0]!.boardId).toBe("hot");
    expect(p0Total).toBe(1);
    expect(activity.some((a) => a.boardId === "hot")).toBe(true);
  });

  test("githubCommitUrl parses https and ssh remotes", () => {
    expect(
      githubCommitUrl("https://github.com/acme/app.git", "abc123"),
    ).toBe("https://github.com/acme/app/commit/abc123");
    expect(
      githubCommitUrl("git@github.com:acme/app.git", "deadbeef"),
    ).toBe("https://github.com/acme/app/commit/deadbeef");
    expect(githubCommitUrl("https://gitlab.com/x/y", "abc")).toBeNull();
  });
});
