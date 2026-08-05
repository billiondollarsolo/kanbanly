/**
 * Progress affordances.
 *
 * Two shapes, deliberately separate rather than one configurable bar: the card
 * face shows a single 2px fill (how much of one checklist is done), the
 * portfolio tile shows a weighted multi-colour bar (how a board's cards are
 * spread across its columns). They share no markup, only the idea.
 */

/**
 * Done/total as a whole percent. Guards total = 0, which the card face never
 * hits (the block is conditional on a non-empty checklist) but which a caller
 * with a server-supplied count easily could — `0/0` must read as 0%, not NaN%.
 */
export function progressPercent(done: number, total: number): number {
  if (!Number.isFinite(total) || total <= 0) return 0;
  return Math.round((done / total) * 100);
}

type ProgressBarProps = {
  done: number;
  total: number;
  /** Caption on the left of the head row. */
  label?: string;
  testId?: string;
};

/**
 * Card-face checklist progress: label row (`checklist  3/5`) over a 2px track.
 * The fill inherits `--col-accent` from the card, so no colour prop is needed.
 */
export function ProgressBar({
  done,
  total,
  label = "checklist",
  testId,
}: ProgressBarProps) {
  return (
    <div className="kb-card-checklist" data-testid={testId}>
      <div className="kb-card-checklist-head">
        <span>{label}</span>
        <span>
          {done}/{total}
        </span>
      </div>
      <div className="kb-card-checklist-track">
        <div
          className="kb-card-checklist-fill"
          style={{ width: `${progressPercent(done, total)}%` }}
        />
      </div>
    </div>
  );
}

export type BarSegment = {
  /** Stable react key — the column id at the portfolio call site. */
  key: string;
  /** Raw count. Relative widths come from the ratio of these. */
  weight: number;
  color?: string;
  title?: string;
};

/** An empty column still gets a hairline, so the bar shows the whole shape. */
export const MIN_SEGMENT_FLEX = 0.001;

/** Weight → flex grow factor, keeping zero-weight segments visible. */
export function segmentFlex(weight: number): number {
  return weight || MIN_SEGMENT_FLEX;
}

type SegmentBarProps = {
  segments: BarSegment[];
  testId?: string;
};

/** Portfolio tile distribution bar: one flex-weighted div per column. */
export function SegmentBar({ segments, testId }: SegmentBarProps) {
  return (
    <div className="kb-portfolio-segbar" data-testid={testId}>
      {segments.map((s) => (
        <div
          key={s.key}
          className="kb-portfolio-seg"
          title={s.title}
          style={{ flex: segmentFlex(s.weight), background: s.color }}
        />
      ))}
    </div>
  );
}
