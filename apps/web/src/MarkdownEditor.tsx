import { useCallback, useRef, useState } from "react";
import { renderMarkdown } from "@kanbanly/core";

/**
 * Markdown editor with a formatting toolbar and a preview tab.
 *
 * Deliberately NOT a contenteditable rich-text surface: a card is a markdown
 * file that agents read and git diffs, so the stored value must stay clean
 * markdown. The toolbar writes syntax for you; it never introduces a separate
 * document model that has to be converted back.
 */

type Props = {
  value: string;
  onChange: (next: string) => void;
  rows?: number;
  placeholder?: string;
  testId?: string;
};

/** Apply a transform to the textarea, preserving a sensible selection after. */
type Edit = {
  text: string;
  selectionStart: number;
  selectionEnd: number;
};

/** Wrap the selection in `token` (or unwrap when already wrapped). */
export function toggleWrap(
  text: string,
  start: number,
  end: number,
  token: string,
  placeholder: string,
): Edit {
  const selected = text.slice(start, end);
  const before = text.slice(0, start);
  const after = text.slice(end);

  // Already wrapped → unwrap, so the button toggles.
  if (
    selected.length > 0 &&
    selected.startsWith(token) &&
    selected.endsWith(token) &&
    selected.length >= token.length * 2
  ) {
    const inner = selected.slice(token.length, selected.length - token.length);
    return {
      text: before + inner + after,
      selectionStart: start,
      selectionEnd: start + inner.length,
    };
  }

  const body = selected.length > 0 ? selected : placeholder;
  return {
    text: `${before}${token}${body}${token}${after}`,
    selectionStart: start + token.length,
    selectionEnd: start + token.length + body.length,
  };
}

/** Add or remove `prefix` on every line the selection touches. */
export function togglePrefix(
  text: string,
  start: number,
  end: number,
  prefix: string,
): Edit {
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  const lineEndIdx = text.indexOf("\n", end);
  const lineEnd = lineEndIdx === -1 ? text.length : lineEndIdx;
  const block = text.slice(lineStart, lineEnd);
  const lines = block.split("\n");
  const allPrefixed = lines.every((l) => l.startsWith(prefix));
  const next = lines
    .map((l) => (allPrefixed ? l.slice(prefix.length) : prefix + l))
    .join("\n");
  return {
    text: text.slice(0, lineStart) + next + text.slice(lineEnd),
    selectionStart: lineStart,
    selectionEnd: lineStart + next.length,
  };
}

/** Insert a markdown link around the selection. */
export function insertLink(text: string, start: number, end: number): Edit {
  const selected = text.slice(start, end) || "text";
  const snippet = `[${selected}](url)`;
  const urlOffset = start + selected.length + 3;
  return {
    text: text.slice(0, start) + snippet + text.slice(end),
    // Land the caret on `url` so it can be typed over immediately.
    selectionStart: urlOffset,
    selectionEnd: urlOffset + 3,
  };
}

export function MarkdownEditor({
  value,
  onChange,
  rows = 8,
  placeholder,
  testId,
}: Props) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const [tab, setTab] = useState<"write" | "preview">("write");

  const apply = useCallback(
    (fn: (text: string, start: number, end: number) => Edit) => {
      const el = ref.current;
      if (!el) return;
      const edit = fn(el.value, el.selectionStart, el.selectionEnd);
      onChange(edit.text);
      // Restore selection after React re-renders the controlled value.
      requestAnimationFrame(() => {
        el.focus();
        el.setSelectionRange(edit.selectionStart, edit.selectionEnd);
      });
    },
    [onChange],
  );

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!(e.metaKey || e.ctrlKey)) return;
    const k = e.key.toLowerCase();
    if (k === "b") {
      e.preventDefault();
      apply((t, s, en) => toggleWrap(t, s, en, "**", "bold"));
    } else if (k === "i") {
      e.preventDefault();
      apply((t, s, en) => toggleWrap(t, s, en, "*", "italic"));
    } else if (k === "k") {
      e.preventDefault();
      apply(insertLink);
    }
  };

  const buttons: Array<{
    label: string;
    title: string;
    run: () => void;
    mono?: boolean;
  }> = [
    {
      label: "H",
      title: "Heading",
      run: () => apply((t, s, e) => togglePrefix(t, s, e, "## ")),
    },
    {
      label: "B",
      title: "Bold (⌘B)",
      run: () => apply((t, s, e) => toggleWrap(t, s, e, "**", "bold")),
    },
    {
      label: "I",
      title: "Italic (⌘I)",
      run: () => apply((t, s, e) => toggleWrap(t, s, e, "*", "italic")),
    },
    {
      label: "‹›",
      title: "Code",
      run: () => apply((t, s, e) => toggleWrap(t, s, e, "`", "code")),
      mono: true,
    },
    {
      label: "•",
      title: "Bulleted list",
      run: () => apply((t, s, e) => togglePrefix(t, s, e, "- ")),
    },
    {
      label: "1.",
      title: "Numbered list",
      run: () => apply((t, s, e) => togglePrefix(t, s, e, "1. ")),
      mono: true,
    },
    { label: "🔗", title: "Link (⌘K)", run: () => apply(insertLink) },
  ];

  return (
    <div className="kb-mde" data-testid={testId ? `${testId}-mde` : undefined}>
      <div className="kb-mde-bar">
        <div className="kb-mde-tools">
          {buttons.map((b) => (
            <button
              key={b.title}
              type="button"
              className={`kb-mde-btn${b.mono ? " is-mono" : ""}`}
              title={b.title}
              aria-label={b.title}
              // Keep the textarea selection while the button takes the click.
              onMouseDown={(e) => e.preventDefault()}
              onClick={b.run}
              disabled={tab === "preview"}
            >
              {b.label}
            </button>
          ))}
        </div>
        <div className="kb-mde-tabs">
          <button
            type="button"
            className={`kb-mde-tab${tab === "write" ? " is-on" : ""}`}
            onClick={() => setTab("write")}
            data-testid="mde-tab-write"
          >
            write
          </button>
          <button
            type="button"
            className={`kb-mde-tab${tab === "preview" ? " is-on" : ""}`}
            onClick={() => setTab("preview")}
            data-testid="mde-tab-preview"
          >
            preview
          </button>
        </div>
      </div>
      {tab === "write" ? (
        <textarea
          ref={ref}
          className="kb-mde-input"
          data-testid={testId}
          rows={rows}
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
        />
      ) : (
        <div
          className="kb-md kb-mde-preview"
          data-testid={testId ? `${testId}-preview` : undefined}
          dangerouslySetInnerHTML={{
            __html: renderMarkdown(value) || "<p><em>Nothing to preview</em></p>",
          }}
        />
      )}
    </div>
  );
}
