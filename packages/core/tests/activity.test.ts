import { describe, expect, test } from "bun:test";
import { buildActivityFeed, parseLogLine } from "../src/activity.ts";

describe("parseLogLine", () => {
  test("extracts date and actor", () => {
    const p = parseLogLine("2026-08-04 claude: tests green");
    expect(p.date).toBe("2026-08-04");
    expect(p.actor).toBe("claude");
    expect(p.text).toContain("tests green");
  });
});

describe("buildActivityFeed", () => {
  test("rolls up logs newest first across cards", () => {
    const feed = buildActivityFeed([
      {
        id: "c-a",
        title: "A",
        log: ["2026-08-01 human: created", "2026-08-03 human: moved"],
      },
      {
        id: "c-b",
        title: "B",
        log: ["2026-08-04 claude: shipped"],
      },
    ]);
    expect(feed[0]!.date).toBe("2026-08-04");
    expect(feed[0]!.cardId).toBe("c-b");
    expect(feed.map((e) => e.date)).toEqual([
      "2026-08-04",
      "2026-08-03",
      "2026-08-01",
    ]);
  });

  test("respects limit", () => {
    const feed = buildActivityFeed(
      [
        {
          id: "c-a",
          title: "A",
          log: ["2026-08-01 a", "2026-08-02 b", "2026-08-03 c"],
        },
      ],
      { limit: 2 },
    );
    expect(feed.length).toBe(2);
    expect(feed[0]!.date).toBe("2026-08-03");
  });
});
