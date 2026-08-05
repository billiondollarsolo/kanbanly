/**
 * Inline token primitives — the small coloured spans the board leans on for
 * labels, priorities, due dates and counts.
 *
 * These are deliberately thin. Every one emits the exact kb-* class names
 * styles.css already targets, so swapping the inline markup for a primitive
 * changes no pixels and no test selector. Members of the family that carry real
 * markup variance (PrBadge, the portfolio health badge) compose <Chip> rather
 * than growing another prop here.
 */
import type { CSSProperties, ReactNode } from "react";

/**
 * Compose a chip class string: the base kb-* class, an optional
 * `${base}--${variant}` modifier and any extra state class (`is-attention`).
 *
 * Pure and exported so the class strings can be asserted without a DOM — the
 * class name IS the contract with styles.css, so it is the part worth testing.
 */
export function chipClassName(
  base: string,
  variant?: string | null,
  extra?: string | null,
): string {
  const parts = [base];
  if (variant) parts.push(`${base}--${variant}`);
  const trimmed = extra?.trim();
  if (trimmed) parts.push(trimmed);
  return parts.join(" ");
}

export type ChipProps = {
  /** Base kb-* class for this chip family, e.g. "kb-label". */
  base: string;
  /** Renders `${base}--${variant}` next to the base class. */
  variant?: string | null;
  /** Extra state classes appended verbatim, e.g. "is-attention". */
  className?: string | null;
  title?: string;
  style?: CSSProperties;
  "aria-label"?: string;
  "data-testid"?: string;
  /** Drives the P0/P1/P2 hue selectors in styles.css. */
  "data-priority"?: string;
  children?: ReactNode;
};

/**
 * Generic inline token. Undefined attributes are omitted by React, so a chip
 * without a testid renders byte-identical markup to the hand-written span.
 */
export function Chip({
  base,
  variant,
  className,
  title,
  style,
  "aria-label": ariaLabel,
  "data-testid": testId,
  "data-priority": dataPriority,
  children,
}: ChipProps) {
  return (
    <span
      className={chipClassName(base, variant, className)}
      title={title}
      style={style}
      aria-label={ariaLabel}
      data-testid={testId}
      data-priority={dataPriority}
    >
      {children}
    </span>
  );
}

/**
 * One label chip. The hue arrives as a custom property so the palette stays in
 * exactly one place (the board's `labelColor`) instead of being re-derived
 * here — two hash implementations would silently drift apart.
 */
export function LabelChip({
  label,
  color,
}: {
  label: string;
  color: string;
}) {
  return (
    <Chip base="kb-label" style={{ ["--label-color" as string]: color }}>
      {label}
    </Chip>
  );
}

/** Priority token. `data-priority` — not a class — drives the P0/P1/P2 hue. */
export function PriorityChip({
  priority,
  "data-testid": testId,
}: {
  priority: string;
  "data-testid"?: string;
}) {
  return (
    <Chip base="kb-priority" data-priority={priority} data-testid={testId}>
      {priority}
    </Chip>
  );
}

/** Due-date token. The date is already a display string (`YYYY-MM-DD`). */
export function DueChip({
  due,
  "data-testid": testId,
}: {
  due: string;
  "data-testid"?: string;
}) {
  return (
    <Chip base="kb-due" data-testid={testId}>
      {due}
    </Chip>
  );
}

export type CountBadgeProps = {
  /** The kb-* class for this site — kb-column-count, kb-field-count, … */
  className: string;
  value: ReactNode;
  /** When present renders `value/total` (checklist done-over-total). */
  total?: ReactNode;
  title?: string;
  "aria-label"?: string;
  "data-testid"?: string;
};

/**
 * The small count pill. Each call site keeps its own kb-* class because
 * styles.css sizes and colours them independently; only the markup is shared.
 */
export function CountBadge({
  className,
  value,
  total,
  title,
  "aria-label": ariaLabel,
  "data-testid": testId,
}: CountBadgeProps) {
  return (
    <Chip
      base={className}
      title={title}
      aria-label={ariaLabel}
      data-testid={testId}
    >
      {total == null ? (
        value
      ) : (
        <>
          {value}/{total}
        </>
      )}
    </Chip>
  );
}
