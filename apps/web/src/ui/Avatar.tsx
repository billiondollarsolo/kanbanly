/**
 * Actor swatches — the initials circle in the portfolio footer, the column dot
 * in the portfolio colstats, and the plain assignee chip on a card face.
 *
 * All three are one-span primitives whose only real logic is "derive a stable
 * colour (and sometimes initials) from a name", which now lives in palette.ts.
 * Each keeps the exact kb-* class it has today so styles.css applies unchanged.
 */
import { initialsOf, paletteFor } from "./palette.ts";

type AvatarProps = {
  /** Actor name. Drives both the initials and the background hue. */
  name: string;
  /** kb-* class of the slot this avatar sits in. */
  className?: string;
  title?: string;
  testId?: string;
};

/**
 * Initials circle tinted from the name hash.
 *
 * Renders `<span class="kb-portfolio-avatar" style="background: …">RK</span>` —
 * the portfolio tile footer shape.
 */
export function Avatar({
  name,
  className = "kb-portfolio-avatar",
  title,
  testId,
}: AvatarProps) {
  return (
    <span
      className={className}
      title={title}
      style={{ background: paletteFor(name) }}
      data-testid={testId}
    >
      {initialsOf(name)}
    </span>
  );
}

type DotProps = {
  /** Resolved colour — callers pass the accent they already computed for the
   *  column so the dot, the segment bar and the column header stay in step. */
  color?: string;
  className?: string;
  title?: string;
  testId?: string;
};

/** The small round colour swatch beside a column name in a portfolio tile. */
export function Dot({
  color,
  className = "kb-portfolio-dot",
  title,
  testId,
}: DotProps) {
  return (
    <span
      className={className}
      title={title}
      style={{ background: color }}
      data-testid={testId}
    />
  );
}

type AssigneeChipProps = {
  name: string;
  className?: string;
  title?: string;
  testId?: string;
};

/**
 * The card-face assignee slot.
 *
 * Deliberately NOT an <Avatar>: today this renders the assignee's full name as
 * plain text with no tint, and this is a refactor — swapping in initials and a
 * background would change the rendered DOM. Kept here so the assignee slot and
 * the avatar live together the day the design does converge.
 */
export function AssigneeChip({
  name,
  className = "kb-assignee",
  title,
  testId,
}: AssigneeChipProps) {
  return (
    <span className={className} title={title} data-testid={testId}>
      {name}
    </span>
  );
}
