/**
 * Client-side (and server-reusable) card filtering — pure, no I/O.
 *
 * Combine rules (US-29):
 * - AND across types (query AND labels AND assignee AND column)
 * - OR within a multi-value type (labels: [a,b] matches a OR b)
 */

export type FilterableCard = {
  id: string;
  title: string;
  column: string;
  labels?: string[];
  assignee?: string;
  status?: string;
};

export type CardFilter = {
  query?: string;
  /** Single label (legacy). */
  label?: string;
  /** Multi-label OR set. When set, takes precedence over `label`. */
  labels?: string[];
  assignee?: string;
  /** Multi-assignee OR. */
  assignees?: string[];
  column?: string;
};

export function isFilterActive(filter: CardFilter): boolean {
  return !!(
    filter.query?.trim() ||
    filter.label ||
    (filter.labels && filter.labels.length > 0) ||
    filter.assignee ||
    (filter.assignees && filter.assignees.length > 0) ||
    filter.column
  );
}

export function emptyFilter(): CardFilter {
  return {};
}

export function cardMatchesFilter(card: FilterableCard, filter: CardFilter): boolean {
  if (filter.column && card.column !== filter.column) return false;

  const labels =
    filter.labels && filter.labels.length > 0
      ? filter.labels
      : filter.label
        ? [filter.label]
        : [];
  if (labels.length > 0) {
    const have = new Set(card.labels ?? []);
    if (!labels.some((l) => have.has(l))) return false;
  }

  const assignees =
    filter.assignees && filter.assignees.length > 0
      ? filter.assignees
      : filter.assignee
        ? [filter.assignee]
        : [];
  if (assignees.length > 0) {
    if (!assignees.includes(card.assignee ?? "")) return false;
  }

  const q = filter.query?.trim().toLowerCase();
  if (q) {
    const hay =
      `${card.title} ${card.id} ${card.status ?? ""} ${(card.labels ?? []).join(" ")} ${card.assignee ?? ""}`.toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

export function filterCards<T extends FilterableCard>(
  cards: T[],
  filter: CardFilter,
): T[] {
  return cards.filter((c) => cardMatchesFilter(c, filter));
}

/** Per-column counts after applying filter (for header badges). */
export function filteredColumnCounts<T extends FilterableCard>(
  cardsByColumn: Record<string, T[]>,
  filter: CardFilter,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [col, cards] of Object.entries(cardsByColumn)) {
    out[col] = filterCards(cards, filter).length;
  }
  return out;
}
