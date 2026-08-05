import { describe, expect, test } from "bun:test";
import { chipClassName } from "./Chip.tsx";

describe("chipClassName", () => {
  test("a bare base class is passed through untouched", () => {
    expect(chipClassName("kb-label")).toBe("kb-label");
    expect(chipClassName("kb-due")).toBe("kb-due");
  });

  test("a variant expands to the base--variant modifier", () => {
    expect(chipClassName("kb-portfolio-health", "warn")).toBe(
      "kb-portfolio-health kb-portfolio-health--warn",
    );
    expect(chipClassName("kb-portfolio-badge", "blocked")).toBe(
      "kb-portfolio-badge kb-portfolio-badge--blocked",
    );
  });

  test("extra state classes are appended after the modifier", () => {
    expect(chipClassName("kb-portfolio-health", "risk", "is-attention")).toBe(
      "kb-portfolio-health kb-portfolio-health--risk is-attention",
    );
  });

  test("a leading space on the extra class does not double up", () => {
    // Board.tsx builds these as `${attention ? " is-attention" : ""}`.
    expect(chipClassName("kb-portfolio-health", "ok", " is-attention")).toBe(
      "kb-portfolio-health kb-portfolio-health--ok is-attention",
    );
  });

  test("empty, blank and nullish parts are dropped", () => {
    expect(chipClassName("kb-label", "", "")).toBe("kb-label");
    expect(chipClassName("kb-label", null, null)).toBe("kb-label");
    expect(chipClassName("kb-label", undefined, "   ")).toBe("kb-label");
  });

  test("an extra class without a variant still lands on the base", () => {
    expect(chipClassName("kb-board-menu-item", null, "is-active")).toBe(
      "kb-board-menu-item is-active",
    );
  });
});
