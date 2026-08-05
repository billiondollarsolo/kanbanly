import { describe, expect, test } from "bun:test";
import { MIN_SEGMENT_FLEX, progressPercent, segmentFlex } from "./Progress.tsx";

describe("progressPercent", () => {
  test("reports whole percents", () => {
    expect(progressPercent(1, 2)).toBe(50);
    expect(progressPercent(0, 5)).toBe(0);
    expect(progressPercent(5, 5)).toBe(100);
  });

  test("rounds to the nearest percent", () => {
    expect(progressPercent(1, 3)).toBe(33);
    expect(progressPercent(2, 3)).toBe(67);
  });

  test("an empty checklist is 0%, not NaN%", () => {
    expect(progressPercent(0, 0)).toBe(0);
  });

  test("a negative or non-finite total is 0%", () => {
    expect(progressPercent(3, -1)).toBe(0);
    expect(progressPercent(3, Number.NaN)).toBe(0);
  });
});

describe("segmentFlex", () => {
  test("passes a real count straight through", () => {
    expect(segmentFlex(7)).toBe(7);
  });

  test("keeps an empty column visible as a hairline", () => {
    expect(segmentFlex(0)).toBe(MIN_SEGMENT_FLEX);
  });
});
