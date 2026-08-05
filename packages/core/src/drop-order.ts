import { orderAfter, orderBefore, orderBetween, orderInitial } from "./order.ts";

/** Card identity needed to mint a drop order key. */
export type OrderableCard = {
  id: string;
  order: string;
};

/**
 * Pure helper: given cards already in the target column (any order) and an
 * insertion index among those cards **excluding** the dragged card, mint a
 * fractional order key that lands the card at that position.
 *
 * - index 0 → before first neighbour (or initial if column empty)
 * - index === others.length → after last
 * - otherwise → strictly between neighbours
 *
 * Uses `@kanbanly/core` orderAfter / orderBefore / orderBetween only.
 */
export function orderForDrop(
  targetColumnCards: OrderableCard[],
  draggedId: string,
  index: number,
): string {
  const others = targetColumnCards
    .filter((c) => c.id !== draggedId)
    .slice()
    .sort((a, b) => {
      if (a.order < b.order) return -1;
      if (a.order > b.order) return 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

  const n = others.length;
  const clamped = Math.max(0, Math.min(index, n));

  if (n === 0) return orderInitial();

  if (clamped === 0) {
    return orderBefore(others[0]!.order);
  }
  if (clamped >= n) {
    return orderAfter(others[n - 1]!.order);
  }

  const before = others[clamped - 1]!;
  const after = others[clamped]!;
  return orderBetween(before.order, after.order);
}

/**
 * Resolve drop position into the move payload the OSS write API expects.
 */
export function dropToMovePayload(
  targetColumnId: string,
  targetColumnCards: OrderableCard[],
  draggedId: string,
  index: number,
): { column: string; order: string } {
  return {
    column: targetColumnId,
    order: orderForDrop(targetColumnCards, draggedId, index),
  };
}
