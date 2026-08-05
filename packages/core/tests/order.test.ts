import { describe, expect, test } from "bun:test";
import {
  compareOrder,
  orderAfter,
  orderBefore,
  orderBetween,
  orderInitial,
  sortByOrder,
} from "../src/order.ts";

describe("fractional order keys", () => {
  test("orderAfter(last) sorts after last", () => {
    const last = orderInitial();
    const next = orderAfter(last);
    expect(next > last).toBe(true);
    const next2 = orderAfter(next);
    expect(next2 > next).toBe(true);
  });

  test("orderBefore(first) sorts before first", () => {
    const first = orderInitial();
    const before = orderBefore(first);
    expect(before < first).toBe(true);
    const before2 = orderBefore(before);
    expect(before2 < before).toBe(true);
  });

  test("orderBefore(null/empty) returns an initial key", () => {
    const a = orderBefore(null);
    const b = orderBefore("");
    expect(typeof a).toBe("string");
    expect(a.length).toBeGreaterThan(0);
    expect(typeof b).toBe("string");
    expect(b.length).toBeGreaterThan(0);
  });

  test("orderBetween(a, b) sorts strictly between", () => {
    const a = orderInitial();
    const c = orderAfter(a);
    const b = orderBetween(a, c);
    expect(b > a).toBe(true);
    expect(b < c).toBe(true);
  });

  test("orderBetween(null, first) sorts before first", () => {
    const first = orderAfter(orderInitial());
    const before = orderBetween(null, first);
    expect(before < first).toBe(true);
  });

  test("orderBetween(last, null) sorts after last", () => {
    const last = orderInitial();
    const after = orderBetween(last, null);
    expect(after > last).toBe(true);
  });

  test("1,000 sequential orderBetween inserts at same position stay ordered", () => {
    // Insert 1000 times at the front of a growing list (between null and first)
    const keys: string[] = [orderInitial()];
    for (let i = 0; i < 1000; i++) {
      const mid = orderBetween(null, keys[0]);
      expect(mid < keys[0]!).toBe(true);
      keys.unshift(mid);
    }
    // Entire list must be strictly ascending
    for (let i = 1; i < keys.length; i++) {
      expect(keys[i]! > keys[i - 1]!).toBe(true);
    }
    // Also: 1000 inserts between two fixed neighbours
    const lo = orderInitial();
    const hi = orderAfter(orderAfter(lo));
    expect(lo < hi).toBe(true);
    const between: string[] = [];
    let right = hi;
    for (let i = 0; i < 1000; i++) {
      const mid = orderBetween(lo, right);
      expect(mid > lo).toBe(true);
      expect(mid < right).toBe(true);
      between.push(mid);
      right = mid;
    }
    for (let i = 1; i < between.length; i++) {
      expect(between[i]! < between[i - 1]!).toBe(true);
    }
  });

  test("identical keys tiebreak on card id, lower first", () => {
    expect(compareOrder("m", "m", "c-aaa", "c-bbb")).toBeLessThan(0);
    expect(compareOrder("m", "m", "c-bbb", "c-aaa")).toBeGreaterThan(0);
    const sorted = sortByOrder([
      { id: "c-bbb", order: "m" },
      { id: "c-aaa", order: "m" },
      { id: "c-ccc", order: "a" },
    ]);
    expect(sorted.map((x) => x.id)).toEqual(["c-ccc", "c-aaa", "c-bbb"]);
  });
});
