import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { EmptyState, Field, SectionTitle } from "./Field.tsx";

/**
 * These assert against the literal markup Board.tsx renders today. styles.css
 * is global and class-driven, so a changed class string or a changed element
 * silently restyles the app — the exact strings are the contract.
 */
const html = (el: ReactElement) => renderToStaticMarkup(el);

describe("Field", () => {
  test("defaults to a <label> wrapping its control (detail-assignee)", () => {
    expect(
      html(
        <Field label="Assignee">
          <input name="assignee" />
        </Field>,
      ),
    ).toBe('<label class="kb-field">Assignee<input name="assignee"/></label>');
  });

  test("as=div wraps the caption in a span (detail-log)", () => {
    expect(
      html(
        <Field as="div" label="Log" testId="detail-log">
          <ol />
        </Field>,
      ),
    ).toBe(
      '<div class="kb-field" data-testid="detail-log"><span>Log</span><ol></ol></div>',
    );
  });

  test("count renders a space-separated kb-field-count chip (detail-checklist)", () => {
    expect(
      html(
        <Field as="div" label="Checklist" count="1/3" testId="detail-checklist">
          <ul />
        </Field>,
      ),
    ).toBe(
      '<div class="kb-field" data-testid="detail-checklist">' +
        '<span>Checklist <span class="kb-field-count">1/3</span></span>' +
        "<ul></ul></div>",
    );
  });

  test("a zero count still renders — it is a real value, not an absent one", () => {
    expect(html(<Field as="div" label="Code commits" count={0} />)).toContain(
      '<span class="kb-field-count">0</span>',
    );
  });

  test("no count means no chip at all", () => {
    expect(html(<Field as="div" label="Log" />)).not.toContain("kb-field-count");
  });

  test("an action puts the caption on a kb-field-row (detail-status)", () => {
    expect(
      html(
        <Field
          label="Status"
          action={
            <button type="button" className="kb-linkish">
              Edit
            </button>
          }
        >
          <div className="kb-md" />
        </Field>,
      ),
    ).toBe(
      '<div class="kb-field"><div class="kb-field-row"><span>Status</span>' +
        '<button type="button" class="kb-linkish">Edit</button></div>' +
        '<div class="kb-md"></div></div>',
    );
  });

  test("an action forces a div — a label must not wrap a button", () => {
    const out = html(<Field label="Status" action={<button type="button" />} />);
    expect(out.startsWith("<div")).toBe(true);
    expect(out).not.toContain("<label");
  });

  test("an explicit as wins over the action-derived tag", () => {
    expect(
      html(<Field as="label" label="Status" action={<span>x</span>} />),
    ).toBe('<label class="kb-field">Status</label>');
  });

  test("className is appended after kb-field, never replacing it", () => {
    expect(html(<Field label="X" className="kb-field--wide" />)).toBe(
      '<label class="kb-field kb-field--wide">X</label>',
    );
  });

  test("omits data-testid when no testId is given", () => {
    expect(html(<Field label="X" />)).not.toContain("data-testid");
  });
});

describe("SectionTitle", () => {
  test("renders a bare heading by default (filters, theme)", () => {
    expect(html(<SectionTitle>filters</SectionTitle>)).toBe(
      '<h3 class="kb-settings-section-title">filters</h3>',
    );
  });

  test("an action wraps the heading in kb-settings-section-head (boards)", () => {
    expect(
      html(
        <SectionTitle
          action={
            <button type="button" className="kb-toolbar-btn">
              + add board
            </button>
          }
        >
          boards
        </SectionTitle>,
      ),
    ).toBe(
      '<div class="kb-settings-section-head">' +
        '<h3 class="kb-settings-section-title">boards</h3>' +
        '<button type="button" class="kb-toolbar-btn">+ add board</button></div>',
    );
  });

  test("head keeps the wrapper when there is no action (activity)", () => {
    expect(html(<SectionTitle head>activity</SectionTitle>)).toBe(
      '<div class="kb-settings-section-head">' +
        '<h3 class="kb-settings-section-title">activity</h3></div>',
    );
  });

  test("head={false} drops the wrapper even with an action", () => {
    expect(
      html(
        <SectionTitle head={false} action={<button type="button" />}>
          filters
        </SectionTitle>,
      ),
    ).toBe('<h3 class="kb-settings-section-title">filters</h3>');
  });
});

describe("EmptyState", () => {
  test("defaults to a muted paragraph (No commits yet.)", () => {
    expect(html(<EmptyState>No commits yet.</EmptyState>)).toBe(
      '<p class="kb-muted">No commits yet.</p>',
    );
  });

  test("tone=empty as=div matches the column placeholder", () => {
    expect(
      html(
        <EmptyState tone="empty" as="div" testId="empty-doing">
          Empty
        </EmptyState>,
      ),
    ).toBe('<div class="kb-empty" data-testid="empty-doing">Empty</div>');
  });

  test("tone=empty as a paragraph matches the activity feed", () => {
    expect(html(<EmptyState tone="empty">No log entries yet.</EmptyState>)).toBe(
      '<p class="kb-empty">No log entries yet.</p>',
    );
  });

  test("carries a testId and keeps rich children (board-history-empty)", () => {
    expect(
      html(
        <EmptyState testId="board-history-empty">
          No boards yet — use <strong>+ add board</strong>.
        </EmptyState>,
      ),
    ).toBe(
      '<p class="kb-muted" data-testid="board-history-empty">' +
        "No boards yet — use <strong>+ add board</strong>.</p>",
    );
  });

  test("className is appended after the tone class (kb-log-empty)", () => {
    expect(html(<EmptyState className="kb-log-empty">none</EmptyState>)).toBe(
      '<p class="kb-muted kb-log-empty">none</p>',
    );
  });
});
