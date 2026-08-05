/**
 * Fractional index order keys.
 * Wraps the well-tested `fractional-indexing` algorithm so that
 * thousands of inserts between the same neighbours stay strictly ordered.
 */
import {
  generateKeyBetween,
  generateNKeysBetween,
} from "fractional-indexing";

/** Initial key when a column is empty. */
export function orderInitial(): string {
  return generateKeyBetween(null, null);
}

/** Mint a key that sorts after `last`. */
export function orderAfter(last: string | null | undefined): string {
  if (last == null || last.length === 0) return orderInitial();
  return generateKeyBetween(last, null);
}

/** Mint a key that sorts before `first`. */
export function orderBefore(first: string | null | undefined): string {
  if (first == null || first.length === 0) return orderInitial();
  return generateKeyBetween(null, first);
}

/**
 * Mint a key strictly between `a` and `b`.
 * - a null → before b
 * - b null → after a
 * - both null → initial
 */
export function orderBetween(
  a: string | null | undefined,
  b: string | null | undefined,
): string {
  const left = a == null || a === "" ? null : a;
  const right = b == null || b === "" ? null : b;
  if (left !== null && right !== null && left >= right) {
    throw new Error(
      `orderBetween requires a < b (got ${JSON.stringify(left)} >= ${JSON.stringify(right)})`,
    );
  }
  return generateKeyBetween(left, right);
}

/** Generate n keys between a and b. */
export function orderBetweenN(
  a: string | null | undefined,
  b: string | null | undefined,
  n: number,
): string[] {
  const left = a == null || a === "" ? null : a;
  const right = b == null || b === "" ? null : b;
  return generateNKeysBetween(left, right, n);
}

/** Compare two cards by order key then id (lower id first). */
export function compareOrder(
  orderA: string,
  orderB: string,
  idA: string,
  idB: string,
): number {
  if (orderA < orderB) return -1;
  if (orderA > orderB) return 1;
  if (idA < idB) return -1;
  if (idA > idB) return 1;
  return 0;
}

/** Sort cards by order then id. */
export function sortByOrder<T extends { order: string; id: string }>(items: T[]): T[] {
  return items.sort((x, y) => compareOrder(x.order, y.order, x.id, y.id));
}
