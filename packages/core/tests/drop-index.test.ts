import { describe, expect, test } from "bun:test";
import {
  isInnermostDropTarget,
  resolveDropIndex,
} from "../src/drop-index.ts";

describe("resolveDropIndex (innermost target only)", () => {
  const cards = [{ id: "c-a" }, { id: "c-b" }, { id: "c-c" }];

  test("column target appends after last (or 0 when empty)", () => {
    expect(
      resolveDropIndex({
        draggedId: "c-x",
        columnCards: cards,
        target: { type: "column" },
      }),
    ).toBe(3);
    expect(
      resolveDropIndex({
        draggedId: "c-x",
        columnCards: [],
        target: { type: "column" },
      }),
    ).toBe(0);
  });

  test("card-slot top edge inserts before that card", () => {
    expect(
      resolveDropIndex({
        draggedId: "c-x",
        columnCards: cards,
        target: { type: "card-slot", cardId: "c-b", edge: "top" },
      }),
    ).toBe(1);
  });

  test("card-slot bottom edge inserts after that card", () => {
    expect(
      resolveDropIndex({
        draggedId: "c-x",
        columnCards: cards,
        target: { type: "card-slot", cardId: "c-b", edge: "bottom" },
      }),
    ).toBe(2);
  });

  test("excludes dragged card from index neighbours", () => {
    // Dragging c-b onto c-a bottom → others = [c-a, c-c], pos of c-a = 0 → index 1
    expect(
      resolveDropIndex({
        draggedId: "c-b",
        columnCards: cards,
        target: { type: "card-slot", cardId: "c-a", edge: "bottom" },
      }),
    ).toBe(1);
  });

  test("null edge defaults to bottom", () => {
    expect(
      resolveDropIndex({
        draggedId: "c-x",
        columnCards: cards,
        target: { type: "card-slot", cardId: "c-a", edge: null },
      }),
    ).toBe(1);
  });
});

describe("isInnermostDropTarget", () => {
  test("true only when self is first in dropTargets list", () => {
    const a = { element: { id: "a" } as unknown as Element };
    const b = { element: { id: "b" } as unknown as Element };
    expect(isInnermostDropTarget(a.element, [a, b])).toBe(true);
    expect(isInnermostDropTarget(b.element, [a, b])).toBe(false);
    expect(isInnermostDropTarget(a.element, [])).toBe(false);
  });
});
