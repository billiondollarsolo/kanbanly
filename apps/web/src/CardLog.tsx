/**
 * Card `## Log` rendering.
 *
 * Log lines are structured records (`YYYY-MM-DD actor: message`), not prose, so
 * they get a real layout instead of being passed through the markdown renderer
 * — which wrapped each line in a <p> inside an <li> and produced boxed rows.
 */

export type LogEntry = {
  date: string | null;
  actor: string | null;
  message: string;
  /** Original line, kept for anything that does not match the shape. */
  raw: string;
};

const LINE_RE = /^(\d{4}-\d{2}-\d{2})\s+([^:]{1,40}):\s*(.*)$/;

/** Split `2026-08-05 claude: moved backlog → doing` into its parts. */
export function parseLogLine(line: string): LogEntry {
  const raw = line.trim();
  const m = raw.match(LINE_RE);
  if (!m) return { date: null, actor: null, message: raw, raw };
  return {
    date: m[1]!,
    actor: m[2]!.trim(),
    message: m[3]!.trim(),
    raw,
  };
}

/** Newest first — the Log is appended to, so the tail is the recent end. */
export function parseLog(lines: string[] | undefined): LogEntry[] {
  return (lines ?? [])
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map(parseLogLine)
    .reverse();
}

export function CardLog({
  lines,
  actorColor,
}: {
  lines: string[] | undefined;
  actorColor?: (actor: string) => string;
}) {
  const entries = parseLog(lines);
  if (entries.length === 0) {
    return <p className="kb-muted kb-log-empty">No log entries yet.</p>;
  }
  return (
    <ol className="kb-log" data-testid="card-log">
      {entries.map((e, i) => (
        <li key={`${e.raw}-${i}`} className="kb-log-row">
          {e.date ? <span className="kb-log-date">{e.date}</span> : null}
          {e.actor ? (
            <span
              className="kb-log-actor"
              style={
                actorColor ? { color: actorColor(e.actor) } : undefined
              }
            >
              {e.actor}
            </span>
          ) : null}
          <span className="kb-log-msg">{e.message}</span>
        </li>
      ))}
    </ol>
  );
}
