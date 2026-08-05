import { describe, expect, test } from "bun:test";
import {
  boardNotesRelPath,
  defaultProjectNotes,
  mergeCodeBindingSettings,
  parseGitLogLines,
  resolveCodeBinding,
} from "../src/project-cockpit.ts";
import { boardsAgentsMd } from "../src/setup.ts";
import { agentsMdConforms } from "../src/skill-conformance.ts";

describe("project-cockpit pure helpers", () => {
  test("resolveCodeBinding reads settings.code", () => {
    expect(resolveCodeBinding({})).toBeNull();
    expect(
      resolveCodeBinding({ code: { path: "/tmp/app", remote: "https://x" } }),
    ).toEqual({ path: "/tmp/app", remote: "https://x" });
  });

  test("mergeCodeBindingSettings sets and clears", () => {
    const withCode = mergeCodeBindingSettings({ theme: "dark" }, {
      path: "/a",
    });
    expect(withCode.theme).toBe("dark");
    expect((withCode.code as { path: string }).path).toBe("/a");
    const cleared = mergeCodeBindingSettings(withCode, null);
    expect(cleared.code).toBeUndefined();
    expect(cleared.theme).toBe("dark");
  });

  test("parseGitLogLines maps tab-separated git log", () => {
    const out = parseGitLogLines(
      "abc\t2026-08-05T12:00:00Z\talice\tfeat: ship it\ndef\t2026-08-04T12:00:00Z\tbob\tfix: typo\n",
    );
    expect(out).toHaveLength(2);
    expect(out[0]!.subject).toBe("feat: ship it");
    expect(out[0]!.sha).toBe("abc");
  });

  test("boardNotesRelPath layout A and B", () => {
    expect(boardNotesRelPath("backend")).toBe("backend/NOTES.md");
    expect(boardNotesRelPath(".")).toBe("NOTES.md");
  });

  test("defaultProjectNotes includes agent standing orders", () => {
    const n = defaultProjectNotes("App");
    expect(n).toContain("# App");
    expect(n).toMatch(/Agent standing orders/i);
  });

  test("boardsAgentsMd includes session protocol + NOTES + SHA", () => {
    const md = boardsAgentsMd();
    const c = agentsMdConforms(md);
    expect(c.ok).toBe(true);
    expect(c.missing).toEqual([]);
  });
});
