import { describe, expect, test } from "bun:test";
import { alertKey, pruneAcked } from "./alerts.ts";

const p0 = (boardId: string, message: string) => ({
  boardId,
  kind: "p0_open",
  message,
});

describe("alertKey", () => {
  test("is stable for the same condition", () => {
    expect(alertKey(p0("b1", "2 P0 card(s) open"))).toBe(
      alertKey(p0("b1", "2 P0 card(s) open")),
    );
  });

  test("a worsening condition is a different alert", () => {
    // Acknowledging 2 open P0s must not silence 5 open P0s.
    expect(alertKey(p0("b1", "2 P0 card(s) open"))).not.toBe(
      alertKey(p0("b1", "5 P0 card(s) open")),
    );
  });

  test("same message on different boards stays distinct", () => {
    expect(alertKey(p0("b1", "2 P0 card(s) open"))).not.toBe(
      alertKey(p0("b2", "2 P0 card(s) open")),
    );
  });

  test("different kinds on one board stay distinct", () => {
    expect(alertKey({ boardId: "b1", kind: "p0_open", message: "x" })).not.toBe(
      alertKey({ boardId: "b1", kind: "wip_over", message: "x" }),
    );
  });
});

describe("pruneAcked", () => {
  test("drops acks whose condition is gone", () => {
    const live = [p0("b1", "2 P0 card(s) open")];
    const acked = new Set([
      alertKey(p0("b1", "2 P0 card(s) open")),
      alertKey(p0("b2", "1 P0 card(s) open")), // resolved
    ]);
    const next = pruneAcked(acked, live);
    expect([...next]).toEqual([alertKey(p0("b1", "2 P0 card(s) open"))]);
  });

  test("returns the same instance when nothing changed", () => {
    const live = [p0("b1", "2 P0 card(s) open")];
    const acked = new Set([alertKey(p0("b1", "2 P0 card(s) open"))]);
    expect(pruneAcked(acked, live)).toBe(acked);
  });

  test("a resolved-then-recurring alert comes back unread", () => {
    const issue = p0("b1", "2 P0 card(s) open");
    let acked = new Set([alertKey(issue)]);
    acked = pruneAcked(acked, []); // condition clears
    expect(acked.size).toBe(0);
    // ...and returns later: no longer acknowledged, so it shows as unread.
    expect(acked.has(alertKey(issue))).toBe(false);
  });

  test("clears everything when no alerts remain", () => {
    const acked = new Set(["b1:p0_open:x", "b2:wip_over:y"]);
    expect(pruneAcked(acked, []).size).toBe(0);
  });
});
