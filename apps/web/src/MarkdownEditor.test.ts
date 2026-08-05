import { describe, expect, test } from "bun:test";
import { insertLink, togglePrefix, toggleWrap } from "./MarkdownEditor.tsx";

describe("toggleWrap", () => {
  test("wraps the selection", () => {
    const r = toggleWrap("make me bold", 8, 12, "**", "bold");
    expect(r.text).toBe("make me **bold**");
    // Selection stays on the word, not the markers.
    expect(r.text.slice(r.selectionStart, r.selectionEnd)).toBe("bold");
  });

  test("unwraps when the selection is already wrapped", () => {
    const r = toggleWrap("make me **bold**", 8, 16, "**", "bold");
    expect(r.text).toBe("make me bold");
    expect(r.text.slice(r.selectionStart, r.selectionEnd)).toBe("bold");
  });

  test("inserts a placeholder when nothing is selected", () => {
    const r = toggleWrap("", 0, 0, "**", "bold");
    expect(r.text).toBe("**bold**");
    expect(r.text.slice(r.selectionStart, r.selectionEnd)).toBe("bold");
  });

  test("handles single-character tokens", () => {
    expect(toggleWrap("x", 0, 1, "`", "code").text).toBe("`x`");
  });
});

describe("togglePrefix", () => {
  test("prefixes the line the caret sits on", () => {
    expect(togglePrefix("hello", 2, 2, "- ").text).toBe("- hello");
  });

  test("prefixes every line the selection touches", () => {
    const r = togglePrefix("a\nb\nc", 0, 5, "- ");
    expect(r.text).toBe("- a\n- b\n- c");
  });

  test("removes the prefix when all lines already have it", () => {
    const r = togglePrefix("- a\n- b", 0, 7, "- ");
    expect(r.text).toBe("a\nb");
  });

  test("adds to all when only some lines have it", () => {
    const r = togglePrefix("- a\nb", 0, 5, "- ");
    expect(r.text).toBe("- - a\n- b");
  });

  test("does not disturb lines outside the selection", () => {
    const text = "keep\ntarget\nkeep2";
    const r = togglePrefix(text, 5, 5, "## ");
    expect(r.text).toBe("keep\n## target\nkeep2");
  });
});

describe("insertLink", () => {
  test("wraps the selection and lands the caret on the url", () => {
    const r = insertLink("see docs", 4, 8);
    expect(r.text).toBe("see [docs](url)");
    expect(r.text.slice(r.selectionStart, r.selectionEnd)).toBe("url");
  });

  test("uses a placeholder when nothing is selected", () => {
    const r = insertLink("", 0, 0);
    expect(r.text).toBe("[text](url)");
    expect(r.text.slice(r.selectionStart, r.selectionEnd)).toBe("url");
  });
});
