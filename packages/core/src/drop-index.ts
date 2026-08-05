/**
 * Pure drop-index resolution for nested Pragmatic drop targets.
 * Call only for the **innermost** target (location.current.dropTargets[0]).
 */

export type DropEdge = "top" | "bottom" | "left" | "right";

export type InnermostDropTarget =
  | { type: "column" }
  | { type: "card-slot"; cardId: string; edge: DropEdge | null };

/**
 * Compute insertion index among cards in the target column, excluding the
 * dragged card. Used by the board UI after a Pragmatic drop.
 *
 * - column chrome / empty column → append (others.length, which is 0 when empty)
 * - card-slot + top edge → insert before that card
 * - card-slot + bottom edge (default) → insert after that card
 */
export function resolveDropIndex(args: {
  draggedId: string;
  columnCards: Array<{ id: string }>;
  target: InnermostDropTarget;
}): number {
  const others = args.columnCards.filter((c) => c.id !== args.draggedId);
  const target = args.target;
  if (target.type === "column") {
    return others.length;
  }
  const pos = others.findIndex((c) => c.id === target.cardId);
  if (pos < 0) return others.length;
  const edge = target.edge ?? "bottom";
  return edge === "top" ? pos : pos + 1;
}

/**
 * Pragmatic fires onDrop for every drop target under the pointer.
 * Only the innermost (first in location.current.dropTargets) should commit.
 */
export function isInnermostDropTarget(
  selfElement: Element,
  dropTargets: Array<{ element: Element }>,
): boolean {
  const first = dropTargets[0];
  if (!first) return false;
  return first.element === selfElement;
}
