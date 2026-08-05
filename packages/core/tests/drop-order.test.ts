import { describe, expect, test } from "bun:test";
import {
  dropToMovePayload,
  orderForDrop,
} from "../src/drop-order.ts";
import { orderAfter, orderInitial } from "../src/order.ts";

describe("orderForDrop (pure drop → order)", () => {
  test("empty column → initial order", () => {
    const order = orderForDrop([], "c-drag", 0);
    expect(order).toBe(orderInitial());
  });

  test("index 0 → before first neighbour", () => {
    const first = orderInitial();
    const second = orderAfter(first);
    const cards = [
      { id: "c-a", order: first },
      { id: "c-b", order: second },
    ];
    const order = orderForDrop(cards, "c-drag", 0);
    expect(order < first).toBe(true);
  });

  test("after last → sorts after last neighbour", () => {
    const first = orderInitial();
    const second = orderAfter(first);
    const cards = [
      { id: "c-a", order: first },
      { id: "c-b", order: second },
    ];
    const order = orderForDrop(cards, "c-drag", 2);
    expect(order > second).toBe(true);
  });

  test("between two neighbours → strictly between", () => {
    const a = orderInitial();
    const b = orderAfter(a);
    const cards = [
      { id: "c-a", order: a },
      { id: "c-b", order: b },
    ];
    const order = orderForDrop(cards, "c-drag", 1);
    expect(order > a).toBe(true);
    expect(order < b).toBe(true);
  });

  test("excludes dragged card from neighbour set", () => {
    const a = orderInitial();
    const b = orderAfter(a);
    const c = orderAfter(b);
    // Dragging c-b out and re-inserting at index 0 among remaining
    const cards = [
      { id: "c-a", order: a },
      { id: "c-b", order: b },
      { id: "c-c", order: c },
    ];
    const order = orderForDrop(cards, "c-b", 0);
    // others = c-a, c-c; index 0 → before c-a
    expect(order < a).toBe(true);
  });

  test("dropToMovePayload includes column + order", () => {
    const a = orderInitial();
    const payload = dropToMovePayload(
      "doing",
      [{ id: "c-a", order: a }],
      "c-new",
      1,
    );
    expect(payload.column).toBe("doing");
    expect(payload.order > a).toBe(true);
  });

  test("clamps index to valid range", () => {
    const a = orderInitial();
    const cards = [{ id: "c-a", order: a }];
    const high = orderForDrop(cards, "c-x", 99);
    expect(high > a).toBe(true);
    const low = orderForDrop(cards, "c-x", -5);
    expect(low < a).toBe(true);
  });
});
