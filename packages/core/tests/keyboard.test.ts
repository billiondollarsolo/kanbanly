import { describe, expect, test } from "bun:test";
import {
  keyToMoveDirection,
  keyToNavDirection,
  keyboardMoveTarget,
  navigateFocus,
  type NavBoard,
} from "../src/keyboard.ts";

function board(): NavBoard {
  return {
    columns: [
      { id: "backlog" },
      { id: "doing" },
      { id: "done" },
    ],
    cardsByColumn: {
      backlog: [
        { id: "c-a", column: "backlog", order: "a0" },
        { id: "c-b", column: "backlog", order: "a1" },
      ],
      doing: [{ id: "c-c", column: "doing", order: "a0" }],
      done: [],
    },
  };
}

describe("navigateFocus", () => {
  test("starts at first card when no focus", () => {
    expect(navigateFocus(board(), null, "down")).toBe("c-a");
  });

  test("up/down within column", () => {
    expect(navigateFocus(board(), "c-a", "down")).toBe("c-b");
    expect(navigateFocus(board(), "c-b", "up")).toBe("c-a");
    expect(navigateFocus(board(), "c-a", "up")).toBe("c-a");
  });

  test("left/right across columns clamps row", () => {
    expect(navigateFocus(board(), "c-a", "right")).toBe("c-c");
    expect(navigateFocus(board(), "c-b", "right")).toBe("c-c"); // clamp to only card
    expect(navigateFocus(board(), "c-c", "left")).toBe("c-a"); // row 0
    // skip empty done column
    expect(navigateFocus(board(), "c-c", "right")).toBe("c-c");
  });
});

describe("keyboardMoveTarget", () => {
  test("moves to adjacent column at end index", () => {
    const t = keyboardMoveTarget(board(), "c-a", "right");
    expect(t).toEqual({ columnId: "doing", insertIndex: 1 });
    expect(keyboardMoveTarget(board(), "c-a", "left")).toBeNull();
  });
});

describe("key maps", () => {
  test("arrows and vim keys", () => {
    expect(keyToNavDirection("ArrowUp")).toBe("up");
    expect(keyToNavDirection("j")).toBe("down");
    expect(keyToNavDirection("h")).toBe("left");
    expect(keyToNavDirection("x")).toBeNull();
  });

  test("shift+arrow moves column", () => {
    expect(keyToMoveDirection("ArrowLeft", true)).toBe("left");
    expect(keyToMoveDirection("ArrowRight", true)).toBe("right");
    expect(keyToMoveDirection("ArrowLeft", false)).toBeNull();
  });
});
