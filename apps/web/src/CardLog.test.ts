import { describe, expect, test } from "bun:test";
import { parseLog, parseLogLine } from "./CardLog.tsx";

describe("parseLogLine", () => {
  test("splits date, actor and message", () => {
    expect(parseLogLine("2026-08-04 human: created")).toEqual({
      date: "2026-08-04",
      actor: "human",
      message: "created",
      raw: "2026-08-04 human: created",
    });
  });

  test("keeps colons inside the message", () => {
    const e = parseLogLine("2026-08-05 claude: session-end — fixed: the thing");
    expect(e.actor).toBe("claude");
    expect(e.message).toBe("session-end — fixed: the thing");
  });

  test("handles arrows and ratios used by move/checklist entries", () => {
    expect(parseLogLine("2026-08-05 mj: updated checklist 0/0→1/2").message).toBe(
      "updated checklist 0/0→1/2",
    );
    expect(parseLogLine("2026-08-04 claude: moved backlog → doing").message).toBe(
      "moved backlog → doing",
    );
  });

  test("an unstructured line falls back to the whole text", () => {
    const e = parseLogLine("just a note");
    expect(e.date).toBeNull();
    expect(e.actor).toBeNull();
    expect(e.message).toBe("just a note");
  });

  test("a long prefix before a colon is not mistaken for an actor", () => {
    // Guards against swallowing a sentence into the actor slot.
    const long = "2026-08-05 " + "x".repeat(60) + ": tail";
    expect(parseLogLine(long).actor).toBeNull();
  });
});

describe("parseLog", () => {
  test("returns newest first", () => {
    const out = parseLog([
      "2026-08-01 mj: first",
      "2026-08-02 mj: second",
      "2026-08-03 mj: third",
    ]);
    expect(out.map((e) => e.message)).toEqual(["third", "second", "first"]);
  });

  test("drops blank lines", () => {
    expect(parseLog(["", "  ", "2026-08-01 mj: x"]).length).toBe(1);
  });

  test("undefined is empty", () => {
    expect(parseLog(undefined)).toEqual([]);
  });
});
