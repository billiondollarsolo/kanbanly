/**
 * Pure optimistic board updates for the UI — no I/O.
 * Apply locally before the server round-trip completes; reconcile on reload.
 */

export type OptimisticCard = {
  id: string;
  title: string;
  column: string;
  order: string;
  labels?: string[];
  assignee?: string;
  status?: string;
  log?: string[];
  updated?: string;
  filename?: string;
  path?: string;
};

export type OptimisticBoard = {
  id: string;
  path: string;
  columns: Array<{ id: string; name: string }>;
  labels: unknown[];
  settings: Record<string, unknown>;
  cardsByColumn: Record<string, OptimisticCard[]>;
  cards: OptimisticCard[];
};

function sortCards(cards: OptimisticCard[]): OptimisticCard[] {
  return cards.slice().sort((a, b) => {
    if (a.order < b.order) return -1;
    if (a.order > b.order) return 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

function rebuildGroups(
  columns: Array<{ id: string }>,
  cards: OptimisticCard[],
): Record<string, OptimisticCard[]> {
  const groups: Record<string, OptimisticCard[]> = {};
  for (const col of columns) groups[col.id] = [];
  for (const c of cards) {
    if (!groups[c.column]) groups[c.column] = [];
    groups[c.column]!.push(c);
  }
  for (const id of Object.keys(groups)) {
    groups[id] = sortCards(groups[id]!);
  }
  return groups;
}

/** Move a card to a new column/order optimistically. */
export function applyOptimisticMove(
  board: OptimisticBoard,
  cardId: string,
  column: string,
  order: string,
): OptimisticBoard {
  const cards = board.cards.map((c) =>
    c.id === cardId ? { ...c, column, order } : { ...c },
  );
  return {
    ...board,
    cards: sortCards(cards),
    cardsByColumn: rebuildGroups(board.columns, cards),
  };
}

/** Insert a newly created card optimistically. */
export function applyOptimisticCreate(
  board: OptimisticBoard,
  card: OptimisticCard,
): OptimisticBoard {
  if (board.cards.some((c) => c.id === card.id)) {
    return applyOptimisticMove(board, card.id, card.column, card.order);
  }
  const cards = [...board.cards, card];
  return {
    ...board,
    cards: sortCards(cards),
    cardsByColumn: rebuildGroups(board.columns, cards),
  };
}
