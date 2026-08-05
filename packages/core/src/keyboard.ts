/**
 * Pure keyboard navigation / move helpers for the board grid.
 * No I/O — UI applies focus + calls write path with returned payload.
 */

export type NavCard = {
  id: string;
  column: string;
  order: string;
};

export type NavColumn = { id: string; name?: string };

export type NavBoard = {
  columns: NavColumn[];
  /** Cards per column, already sorted by order then id. */
  cardsByColumn: Record<string, NavCard[]>;
};

export type NavDirection = "up" | "down" | "left" | "right";

function sortedCol(board: NavBoard, columnId: string): NavCard[] {
  const cards = board.cardsByColumn[columnId] ?? [];
  return cards.slice().sort((a, b) => {
    if (a.order < b.order) return -1;
    if (a.order > b.order) return 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

function findCard(
  board: NavBoard,
  cardId: string,
): { columnIndex: number; rowIndex: number; card: NavCard } | null {
  for (let ci = 0; ci < board.columns.length; ci++) {
    const colId = board.columns[ci]!.id;
    const cards = sortedCol(board, colId);
    const ri = cards.findIndex((c) => c.id === cardId);
    if (ri >= 0) return { columnIndex: ci, rowIndex: ri, card: cards[ri]! };
  }
  return null;
}

/**
 * Move focus within the board grid.
 * - up/down: within column (clamped)
 * - left/right: adjacent column, same row index (clamped to column length)
 * Returns new focused card id, or null if no cards / unknown focus.
 */
export function navigateFocus(
  board: NavBoard,
  focusedId: string | null,
  direction: NavDirection,
): string | null {
  const cols = board.columns;
  if (cols.length === 0) return null;

  // No focus yet → first card in first non-empty column
  if (!focusedId) {
    for (const col of cols) {
      const cards = sortedCol(board, col.id);
      if (cards[0]) return cards[0].id;
    }
    return null;
  }

  const loc = findCard(board, focusedId);
  if (!loc) {
    for (const col of cols) {
      const cards = sortedCol(board, col.id);
      if (cards[0]) return cards[0].id;
    }
    return null;
  }

  const { columnIndex, rowIndex } = loc;

  if (direction === "up") {
    const cards = sortedCol(board, cols[columnIndex]!.id);
    if (rowIndex <= 0) return cards[0]?.id ?? focusedId;
    return cards[rowIndex - 1]!.id;
  }

  if (direction === "down") {
    const cards = sortedCol(board, cols[columnIndex]!.id);
    if (rowIndex >= cards.length - 1) return cards[cards.length - 1]?.id ?? focusedId;
    return cards[rowIndex + 1]!.id;
  }

  if (direction === "left" || direction === "right") {
    const delta = direction === "left" ? -1 : 1;
    let ci = columnIndex + delta;
    while (ci >= 0 && ci < cols.length) {
      const cards = sortedCol(board, cols[ci]!.id);
      if (cards.length > 0) {
        const ri = Math.min(rowIndex, cards.length - 1);
        return cards[ri]!.id;
      }
      ci += delta;
    }
    return focusedId;
  }

  return focusedId;
}

/**
 * Compute a keyboard move into an adjacent column.
 * - left/right only
 * - lands after last card in target column (agent-style append)
 * Returns null if cannot move (edge column / empty board).
 */
export function keyboardMoveTarget(
  board: NavBoard,
  cardId: string,
  direction: "left" | "right",
): { columnId: string; insertIndex: number } | null {
  const loc = findCard(board, cardId);
  if (!loc) return null;
  const delta = direction === "left" ? -1 : 1;
  const targetCi = loc.columnIndex + delta;
  if (targetCi < 0 || targetCi >= board.columns.length) return null;
  const targetColId = board.columns[targetCi]!.id;
  // Insert at end among others in target (excluding self if already there — shouldn't be)
  const others = sortedCol(board, targetColId).filter((c) => c.id !== cardId);
  return { columnId: targetColId, insertIndex: others.length };
}

/** Map keyboard event key to nav direction (arrows + vim hjkl). */
export function keyToNavDirection(key: string): NavDirection | null {
  switch (key) {
    case "ArrowUp":
    case "k":
      return "up";
    case "ArrowDown":
    case "j":
      return "down";
    case "ArrowLeft":
    case "h":
      return "left";
    case "ArrowRight":
    case "l":
      return "right";
    default:
      return null;
  }
}

/**
 * Move shortcuts: Shift+Arrow or H/L (shift) for column moves.
 * Returns left/right or null.
 */
export function keyToMoveDirection(
  key: string,
  shiftKey: boolean,
): "left" | "right" | null {
  if (shiftKey && (key === "ArrowLeft" || key === "H")) return "left";
  if (shiftKey && (key === "ArrowRight" || key === "L")) return "right";
  // Also support plain H/L when shift held via key "H"/"L"
  if (key === "H" && shiftKey) return "left";
  if (key === "L" && shiftKey) return "right";
  return null;
}
