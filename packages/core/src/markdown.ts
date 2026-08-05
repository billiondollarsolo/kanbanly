/**
 * Minimal Markdown → safe HTML for Status / Log panels.
 * Supports: headings (#..###), paragraphs, soft breaks, **bold**, *italic*,
 * `code`, [links](url), unordered/ordered lists, fenced code blocks.
 * Escapes all HTML first — never injects raw user HTML.
 */

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function inlineMarkdown(escaped: string): string {
  // code spans first
  let s = escaped.replace(/`([^`]+)`/g, "<code>$1</code>");
  // links [text](url) — only http(s)
  s = s.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
    '<a href="$2" target="_blank" rel="noreferrer">$1</a>',
  );
  // bold **text**
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  // italic *text*
  s = s.replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, "$1<em>$2</em>");
  return s;
}

/**
 * Convert markdown text to HTML string (already escaped where needed).
 */
export function renderMarkdown(md: string | undefined | null): string {
  if (md == null || md === "") return "";
  const text = String(md).replace(/\r\n/g, "\n");
  const lines = text.split("\n");
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    // fenced code
    if (line.trimStart().startsWith("```")) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i]!.trimStart().startsWith("```")) {
        body.push(escapeHtml(lines[i]!));
        i += 1;
      }
      if (i < lines.length) i += 1; // closing fence
      out.push(`<pre><code>${body.join("\n")}</code></pre>`);
      continue;
    }

    // ATX heading (#, ##, ###) — levels are offset by one so a card body can
    // never emit an <h1> that competes with the page heading.
    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      const level = Math.min(6, heading[1]!.length + 1);
      out.push(
        `<h${level}>${inlineMarkdown(escapeHtml(heading[2]!.trim()))}</h${level}>`,
      );
      i += 1;
      continue;
    }

    // unordered list
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i]!)) {
        const item = lines[i]!.replace(/^\s*[-*+]\s+/, "");
        items.push(`<li>${inlineMarkdown(escapeHtml(item))}</li>`);
        i += 1;
      }
      out.push(`<ul>${items.join("")}</ul>`);
      continue;
    }

    // ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i]!)) {
        const item = lines[i]!.replace(/^\s*\d+\.\s+/, "");
        items.push(`<li>${inlineMarkdown(escapeHtml(item))}</li>`);
        i += 1;
      }
      out.push(`<ol>${items.join("")}</ol>`);
      continue;
    }

    // blank line
    if (line.trim() === "") {
      i += 1;
      continue;
    }

    // paragraph: gather until blank
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() !== "") {
      // stop if next structural
      if (
        lines[i]!.trimStart().startsWith("```") ||
        /^#{1,3}\s+/.test(lines[i]!) ||
        /^\s*[-*+]\s+/.test(lines[i]!) ||
        /^\s*\d+\.\s+/.test(lines[i]!)
      ) {
        break;
      }
      para.push(escapeHtml(lines[i]!));
      i += 1;
    }
    out.push(`<p>${inlineMarkdown(para.join("<br/>"))}</p>`);
  }

  return out.join("\n");
}
