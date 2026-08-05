/**
 * The three smallest repeated wrappers in the board UI.
 *
 * - `Field`       — the `kb-field` caption + control pair (32 hand-copied sites).
 * - `SectionTitle`— the `kb-settings-section-title` mono/uppercase heading (6 sites).
 * - `EmptyState`  — the muted "nothing here yet" line (30+ sites).
 *
 * These are shells, not a design system: each one emits exactly the class names
 * `styles.css` already targets, so the rendered page is byte-identical to the
 * inline markup they replace. Nothing here owns state or layout of its own.
 */
import type { ReactNode } from "react";

function cx(base: string, extra?: string): string {
  return extra ? `${base} ${extra}` : base;
}

export type FieldProps = {
  /**
   * Caption text. In a `<label>` field this stays a direct child so the
   * `.kb-field` descendant selectors keep matching the text node.
   */
  label: ReactNode;
  children?: ReactNode;
  /**
   * `label` wraps its control — the common case, and what makes the caption
   * clickable. `div` is for fields whose body is not a single form control
   * (the status editor, checklist, log and commit lists).
   *
   * Defaults to `div` when an `action` is present: a `<label>` must not wrap a
   * button, or clicking the action would also activate the field's control.
   */
  as?: "label" | "div";
  /** Trailing `kb-field-count` chip, e.g. the checklist's `2/5`. */
  count?: ReactNode;
  /**
   * Trailing control on the caption row, e.g. the Status Edit/Preview toggle.
   * Renders the caption inside a `kb-field-row` so the two sit apart.
   */
  action?: ReactNode;
  /** Extra classes appended after `kb-field`. */
  className?: string;
  /** Passed through as `data-testid` on the field root. */
  testId?: string;
};

export function Field({
  label,
  children,
  as,
  count,
  action,
  className,
  testId,
}: FieldProps) {
  const tag = as ?? (action ? "div" : "label");
  const cls = cx("kb-field", className);
  const caption =
    count === undefined || count === null ? (
      label
    ) : (
      <>
        {label} <span className="kb-field-count">{count}</span>
      </>
    );

  if (tag === "label") {
    return (
      <label className={cls} data-testid={testId}>
        {caption}
        {children}
      </label>
    );
  }

  return (
    <div className={cls} data-testid={testId}>
      {action ? (
        <div className="kb-field-row">
          <span>{caption}</span>
          {action}
        </div>
      ) : (
        <span>{caption}</span>
      )}
      {children}
    </div>
  );
}

export type SectionTitleProps = {
  children: ReactNode;
  /** Trailing control on the heading row, e.g. the "+ add board" toggle. */
  action?: ReactNode;
  /**
   * Wrap the heading in `kb-settings-section-head`, which moves the underline
   * onto the row so the action sits on the rule rather than under it.
   *
   * Defaults to true when an `action` is present. Pass it explicitly for the
   * Activity section, whose head row is empty but still carries the rule.
   */
  head?: boolean;
  /** Extra classes appended after `kb-settings-section-title`. */
  className?: string;
  /** Passed through as `data-testid` on the heading. */
  testId?: string;
};

export function SectionTitle({
  children,
  action,
  head,
  className,
  testId,
}: SectionTitleProps) {
  const title = (
    <h3 className={cx("kb-settings-section-title", className)} data-testid={testId}>
      {children}
    </h3>
  );
  if (!(head ?? action !== undefined)) return title;
  return (
    <div className="kb-settings-section-head">
      {title}
      {action}
    </div>
  );
}

export type EmptyStateProps = {
  children: ReactNode;
  /**
   * `muted` is the inline note used across settings and the card modal;
   * `empty` is the larger mono placeholder used for an empty column and the
   * activity feed. They are different classes, not variants of one.
   */
  tone?: "muted" | "empty";
  /** `div` matches the column placeholder; every other site is a `p`. */
  as?: "p" | "div";
  /** Extra classes appended after the tone class. */
  className?: string;
  /** Passed through as `data-testid`. */
  testId?: string;
};

export function EmptyState({
  children,
  tone = "muted",
  as = "p",
  className,
  testId,
}: EmptyStateProps) {
  const cls = cx(tone === "empty" ? "kb-empty" : "kb-muted", className);
  if (as === "div") {
    return (
      <div className={cls} data-testid={testId}>
        {children}
      </div>
    );
  }
  return (
    <p className={cls} data-testid={testId}>
      {children}
    </p>
  );
}
