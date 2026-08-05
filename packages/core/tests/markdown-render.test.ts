import { describe, expect, test } from "bun:test";
import { renderMarkdown } from "../src/markdown.ts";

/**
 * renderMarkdown output is injected via dangerouslySetInnerHTML, so the
 * escaping guarantee is load-bearing, not cosmetic.
 */
describe("renderMarkdown escaping", () => {
  test("escapes raw HTML instead of emitting it", () => {
    const out = renderMarkdown("<script>alert(1)</script>");
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt;");
  });

  test("escapes HTML inside a heading", () => {
    const out = renderMarkdown("## <img src=x onerror=alert(1)>");
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;img");
  });

  test("does not linkify javascript: URLs", () => {
    const out = renderMarkdown("[click](javascript:alert(1))");
    expect(out).not.toContain("href=\"javascript:");
  });

  test("http(s) links get a safe href and rel", () => {
    const out = renderMarkdown("[x](https://example.com)");
    expect(out).toContain('href="https://example.com"');
    expect(out).toContain('rel="noreferrer"');
  });

  test("attribute-breaking quotes cannot escape the href", () => {
    const out = renderMarkdown('[x](https://e.com/")onmouseover="alert(1))');
    expect(out).not.toContain('onmouseover="alert(1)"');
  });
});

describe("renderMarkdown headings", () => {
  test("# renders one level down so cards never emit an h1", () => {
    expect(renderMarkdown("# Title")).toBe("<h2>Title</h2>");
  });

  test("## and ### map to h3 and h4", () => {
    expect(renderMarkdown("## A")).toBe("<h3>A</h3>");
    expect(renderMarkdown("### B")).toBe("<h4>B</h4>");
  });

  test("inline formatting still applies inside a heading", () => {
    expect(renderMarkdown("## **bold**")).toContain("<strong>bold</strong>");
  });

  test("a heading terminates the preceding paragraph", () => {
    const out = renderMarkdown("intro\n## Next");
    expect(out).toContain("<p>intro</p>");
    expect(out).toContain("<h3>Next</h3>");
  });

  test("a hash without a space is not a heading", () => {
    expect(renderMarkdown("#hashtag")).toContain("<p>#hashtag</p>");
  });
});
