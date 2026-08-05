/**
 * Board activity feed: roll up every card's ## Log into a sorted timeline.
 * Pure — no I/O.
 */

export type ActivityCard = {
  id: string;
  title: string;
  log: string[];
};

export type ActivityEntry = {
  /** ISO-ish date prefix from log line when present (YYYY-MM-DD). */
  date: string;
  /** Full log line without leading "- ". */
  line: string;
  cardId: string;
  cardTitle: string;
  /** Optional actor parsed after the date. */
  actor?: string;
};

/** "2026-08-04 claude: did thing" */
const DATE_ACTOR_RE = /^(\d{4}-\d{2}-\d{2})\s+(\S+):\s*(.*)$/;
/** "2026-08-04 did thing" (no actor) */
const DATE_ONLY_RE = /^(\d{4}-\d{2}-\d{2})\s+(.*)$/;

/**
 * Parse a single log line into date / actor / rest.
 * Accepts "2026-08-04 claude: did thing" or plain text.
 */
export function parseLogLine(line: string): {
  date: string;
  actor?: string;
  text: string;
} {
  const trimmed = line.replace(/^-\s*/, "").trim();
  const withActor = trimmed.match(DATE_ACTOR_RE);
  if (withActor) {
    return {
      date: withActor[1]!,
      actor: withActor[2],
      text: withActor[3] && withActor[3].length > 0 ? withActor[3]! : trimmed,
    };
  }
  const dateOnly = trimmed.match(DATE_ONLY_RE);
  if (dateOnly) {
    return { date: dateOnly[1]!, text: dateOnly[2] || trimmed };
  }
  return { date: "0000-00-00", text: trimmed };
}

/**
 * Build a board-level activity feed from all cards' Log lines.
 * Sorted newest date first, then card id, then line text.
 */
export function buildActivityFeed(
  cards: ActivityCard[],
  options?: { limit?: number },
): ActivityEntry[] {
  const entries: ActivityEntry[] = [];
  for (const card of cards) {
    for (const raw of card.log ?? []) {
      const parsed = parseLogLine(raw);
      entries.push({
        date: parsed.date,
        line: raw.replace(/^-\s*/, "").trim(),
        cardId: card.id,
        cardTitle: card.title,
        actor: parsed.actor,
      });
    }
  }
  entries.sort((a, b) => {
    if (a.date > b.date) return -1;
    if (a.date < b.date) return 1;
    if (a.cardId < b.cardId) return -1;
    if (a.cardId > b.cardId) return 1;
    return a.line < b.line ? -1 : a.line > b.line ? 1 : 0;
  });
  const limit = options?.limit;
  if (limit !== undefined && limit >= 0) return entries.slice(0, limit);
  return entries;
}
