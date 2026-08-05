import { describe, expect, test } from "bun:test";
import { escapeHtml, renderMarkdown } from "../src/markdown.ts";
import {
  computeAutoScrollDelta,
  applyAutoScroll,
} from "../src/auto-scroll.ts";
import {
  parseBoardRoute,
  parseAppRoute,
  formatBoardRoute,
  formatBoardPath,
  formatSettingsPath,
  formatAppPath,
  writeWindowBoardRoute,
  isSpaBoardPath,
  readWindowBoardRoute,
} from "../src/nav.ts";

describe("renderMarkdown", () => {
  test("escapes raw HTML", () => {
    const html = renderMarkdown(`<script>alert(1)</script>`);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  test("bold italic code links lists", () => {
    const md = `Hello **world** and *italics* with \`code\`

- item one
- item two

See [docs](https://example.com/x).
`;
    const html = renderMarkdown(md);
    expect(html).toContain("<strong>world</strong>");
    expect(html).toContain("<em>italics</em>");
    expect(html).toContain("<code>code</code>");
    expect(html).toContain("<ul>");
    expect(html).toContain("<li>");
    expect(html).toContain('href="https://example.com/x"');
  });

  test("fenced code block", () => {
    const html = renderMarkdown("```\nconst x = 1;\n```");
    expect(html).toContain("<pre><code>");
    expect(html).toContain("const x = 1;");
  });

  test("escapeHtml", () => {
    expect(escapeHtml(`a&b<"'>`)).toBe("a&amp;b&lt;&quot;&#39;&gt;");
  });
});

describe("board route path + hash (US-15)", () => {
  test("parse path-style /r/ and /b/", () => {
    expect(parseBoardRoute("/b/backend")).toEqual({
      remoteSlug: null,
      boardId: "backend",
      cardId: null,
    });
    expect(parseBoardRoute("/b/backend/c-a1b2")).toEqual({
      remoteSlug: null,
      boardId: "backend",
      cardId: "c-a1b2",
    });
    expect(parseBoardRoute("/r/local/b/backend/c-a1b2")).toEqual({
      remoteSlug: "local",
      boardId: "backend",
      cardId: "c-a1b2",
    });
  });

  test("parse hash form still works", () => {
    expect(parseBoardRoute("#/r/local/b/backend")).toEqual({
      remoteSlug: "local",
      boardId: "backend",
      cardId: null,
    });
  });

  test("format path vs hash", () => {
    expect(formatBoardPath("backend", "c-a1b2")).toBe("/b/backend/c-a1b2");
    expect(formatBoardPath("backend", "c-a1b2", "local")).toBe(
      "/r/local/b/backend/c-a1b2",
    );
    expect(formatBoardRoute("backend", "c-a1b2", "local")).toBe(
      "#/r/local/b/backend/c-a1b2",
    );
  });

  test("isSpaBoardPath", () => {
    expect(isSpaBoardPath("/")).toBe(true);
    expect(isSpaBoardPath("/b/backend")).toBe(true);
    expect(isSpaBoardPath("/r/x/b/backend/c-1")).toBe(true);
    expect(isSpaBoardPath("/settings")).toBe(true);
    expect(isSpaBoardPath("/settings/activity")).toBe(true);
    expect(isSpaBoardPath("/settings/boards/b-abc123")).toBe(true);
    expect(isSpaBoardPath("/settings/r/local/boards/b-abc")).toBe(true);
    expect(isSpaBoardPath("/api/boards")).toBe(false);
  });

  test("parseAppRoute settings + board", () => {
    expect(parseAppRoute("/settings/credentials")).toEqual({
      kind: "settings",
      section: "credentials",
      remoteSlug: null,
      boardId: null,
    });
    expect(parseAppRoute("/settings/r/local/boards/b-x7k2")).toEqual({
      kind: "settings",
      section: "boards",
      remoteSlug: "local",
      boardId: "b-x7k2",
    });
    expect(parseAppRoute("/b/b-x7k2/c-a1b2")).toEqual({
      kind: "board",
      remoteSlug: null,
      boardId: "b-x7k2",
      cardId: "c-a1b2",
    });
  });

  test("formatSettingsPath + formatAppPath", () => {
    expect(formatSettingsPath("activity")).toBe("/settings/activity");
    expect(
      formatSettingsPath("boards", { remoteSlug: "local", boardId: "b-1" }),
    ).toBe("/settings/r/local/boards/b-1");
    expect(
      formatAppPath({
        kind: "board",
        remoteSlug: "local",
        boardId: "b-1",
        cardId: "c-2",
      }),
    ).toBe("/r/local/b/b-1/c-2");
  });

  test("readWindowBoardRoute prefers hash when set", () => {
    const r = readWindowBoardRoute(() => ({
      pathname: "/",
      hash: "#/b/web/c-zz",
    }));
    expect(r.boardId).toBe("web");
    expect(r.cardId).toBe("c-zz");
  });

  test("writeWindowBoardRoute path mode", () => {
    let written = "";
    writeWindowBoardRoute("web", "c-zz", {
      remoteSlug: "my-boards",
      mode: "path",
      setLocation: (u) => {
        written = u;
      },
    });
    expect(written).toBe("/r/my-boards/b/web/c-zz");
  });
});

describe("auto-scroll", () => {
  test("near top edge scrolls up", () => {
    const d = computeAutoScrollDelta({
      clientX: 100,
      clientY: 12,
      rect: { top: 0, bottom: 200, left: 0, right: 200, height: 200, width: 200 },
      threshold: 40,
      maxSpeed: 18,
    });
    expect(d.dy).toBeLessThan(0);
    expect(d.edge).toBe("top");
  });

  test("center is zero", () => {
    const d = computeAutoScrollDelta({
      clientX: 100,
      clientY: 100,
      rect: { top: 0, bottom: 200, left: 0, right: 200, height: 200, width: 200 },
    });
    expect(d.dx).toBe(0);
    expect(d.dy).toBe(0);
    expect(d.edge).toBeNull();
  });

  test("applyAutoScroll mutates scrollTop", () => {
    const el = {
      scrollTop: 50,
      scrollLeft: 0,
      scrollHeight: 500,
      clientHeight: 100,
      scrollWidth: 100,
      clientWidth: 100,
    };
    const changed = applyAutoScroll(el, { dx: 0, dy: 10, edge: "bottom" });
    expect(changed).toBe(true);
    expect(el.scrollTop).toBe(60);
  });
});
