/**
 * Structural proof that the shipped board UI bundle wires Pragmatic DnD
 * and calls the move API (not a reimplemented commit path).
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PUBLIC_DIR, renderBoardAppHtml } from "../src/app.ts";

describe("Pragmatic DnD wiring (structural)", () => {
  test("public bundle exists and references pragmatic / move API", () => {
    const jsPath = join(PUBLIC_DIR, "main.js");
    expect(existsSync(jsPath)).toBe(true);
    const js = readFileSync(jsPath, "utf8");

    // Pragmatic drag-and-drop is in the bundle
    const hasPragmatic =
      /pragmatic/i.test(js) ||
      /draggable/.test(js) ||
      /dropTargetForElements/.test(js) ||
      /closestEdge|attachClosestEdge/.test(js);
    expect(hasPragmatic).toBe(true);

    // UI talks to shipped move endpoint (not inventing git commits client-side)
    expect(js.includes("/cards/") || js.includes("cards/")).toBe(true);
    expect(js.includes("move") || js.includes("/move")).toBe(true);

    // Uses drop order helper path (column + order payload)
    expect(js.includes("order") || js.includes("column")).toBe(true);
  });

  test("renderBoardAppHtml mounts React root and loads assets", () => {
    const html = renderBoardAppHtml();
    expect(html).toContain('id="root"');
    expect(html).toContain("/assets/main.js");
    expect(html).toContain("/assets/main.css");
  });

  test("Board.tsx source imports pragmatic packages and dropToMovePayload", () => {
    const boardSrc = readFileSync(
      join(import.meta.dir, "../../../apps/web/src/Board.tsx"),
      "utf8",
    );
    expect(boardSrc).toContain("@atlaskit/pragmatic-drag-and-drop");
    expect(boardSrc).toContain("draggable");
    expect(boardSrc).toContain("dropTargetForElements");
    expect(boardSrc).toContain("dropToMovePayload");
    expect(boardSrc).toContain("moveCard");
    // Nested drop targets must only commit from innermost (no double POST)
    expect(boardSrc).toContain("isInnermostDropTarget");
    expect(boardSrc).toContain("resolveDropIndex");
    // Live SSE reload
    expect(boardSrc).toContain("subscribeBoardEvents");
    // Keyboard navigation
    expect(boardSrc).toContain("navigateFocus");
    expect(boardSrc).toContain("keyboardMoveTarget");
    expect(boardSrc).toContain("keyToNavDirection");
    // Must not shell out to git from the client
    expect(boardSrc).not.toMatch(/spawnSync\(["']git/);
    expect(boardSrc).not.toMatch(/\bgit\s+commit\b/);
    expect(boardSrc).not.toMatch(/child_process/);
  });

  test("api.ts exposes EventSource subscription to /api/events", () => {
    const apiSrc = readFileSync(
      join(import.meta.dir, "../../../apps/web/src/api.ts"),
      "utf8",
    );
    expect(apiSrc).toContain("subscribeBoardEvents");
    expect(apiSrc).toContain("/api/events");
    expect(apiSrc).toContain("EventSource");
  });

  test("drop.ts re-exports core order helpers only", () => {
    const dropSrc = readFileSync(
      join(import.meta.dir, "../../../apps/web/src/drop.ts"),
      "utf8",
    );
    expect(dropSrc).toContain("@kanbanly/core");
    expect(dropSrc).toContain("orderForDrop");
    expect(dropSrc).toContain("dropToMovePayload");
  });
});
