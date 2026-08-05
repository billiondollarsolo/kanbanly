/**
 * Auto-scroll helpers for drag-near-edge (Pragmatic / HTML5 DnD).
 * Pure — callers apply the returned scroll delta to an element.
 */

export type AutoScrollEdge = "top" | "bottom" | "left" | "right" | null;

export type AutoScrollInput = {
  /** Pointer clientY */
  clientY: number;
  /** Pointer clientX */
  clientX: number;
  /** Scroll container bounding rect */
  rect: { top: number; bottom: number; left: number; right: number; height: number; width: number };
  /** Distance from edge that triggers scroll (default 40) */
  threshold?: number;
  /** Max px per tick (default 18) */
  maxSpeed?: number;
};

export type AutoScrollDelta = {
  dx: number;
  dy: number;
  edge: AutoScrollEdge;
};

/**
 * Compute scroll delta when pointer is near a container edge.
 * Returns zero deltas when pointer is outside or in the safe center.
 */
export function computeAutoScrollDelta(input: AutoScrollInput): AutoScrollDelta {
  const threshold = input.threshold ?? 40;
  const maxSpeed = input.maxSpeed ?? 18;
  const { clientX, clientY, rect } = input;

  // Outside container → no scroll
  if (
    clientX < rect.left ||
    clientX > rect.right ||
    clientY < rect.top ||
    clientY > rect.bottom
  ) {
    return { dx: 0, dy: 0, edge: null };
  }

  let dy = 0;
  let dx = 0;
  let edge: AutoScrollEdge = null;

  const fromTop = clientY - rect.top;
  const fromBottom = rect.bottom - clientY;
  const fromLeft = clientX - rect.left;
  const fromRight = rect.right - clientX;

  if (fromTop < threshold) {
    const t = 1 - fromTop / threshold;
    dy = -Math.ceil(maxSpeed * t);
    edge = "top";
  } else if (fromBottom < threshold) {
    const t = 1 - fromBottom / threshold;
    dy = Math.ceil(maxSpeed * t);
    edge = "bottom";
  }

  if (fromLeft < threshold) {
    const t = 1 - fromLeft / threshold;
    dx = -Math.ceil(maxSpeed * t);
    if (!edge) edge = "left";
  } else if (fromRight < threshold) {
    const t = 1 - fromRight / threshold;
    dx = Math.ceil(maxSpeed * t);
    if (!edge) edge = "right";
  }

  return { dx, dy, edge };
}

/**
 * Apply delta to an element; returns whether scroll position changed.
 */
export function applyAutoScroll(
  el: { scrollTop: number; scrollLeft: number; scrollHeight: number; clientHeight: number; scrollWidth: number; clientWidth: number },
  delta: AutoScrollDelta,
): boolean {
  if (delta.dx === 0 && delta.dy === 0) return false;
  const prevTop = el.scrollTop;
  const prevLeft = el.scrollLeft;
  el.scrollTop = Math.max(
    0,
    Math.min(el.scrollHeight - el.clientHeight, el.scrollTop + delta.dy),
  );
  el.scrollLeft = Math.max(
    0,
    Math.min(el.scrollWidth - el.clientWidth, el.scrollLeft + delta.dx),
  );
  return el.scrollTop !== prevTop || el.scrollLeft !== prevLeft;
}
