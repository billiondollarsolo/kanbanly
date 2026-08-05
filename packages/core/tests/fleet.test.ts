import { describe, expect, test } from "bun:test";
import {
  buildFleetHealth,
  fleetWebhookPayload,
  formatFleetDigest,
  isHardWip,
} from "../src/fleet.ts";

describe("fleet health", () => {
  test("isHardWip", () => {
    expect(isHardWip({ wipHard: true })).toBe(true);
    expect(isHardWip({ wipHard: false })).toBe(false);
    expect(isHardWip({})).toBe(false);
  });

  test("flags P0, stale doing, silent, WIP over", () => {
    const now = Date.parse("2026-08-05T12:00:00Z");
    const health = buildFleetHealth(
      [
        {
          id: "b-hot",
          title: "Hot",
          columns: [
            { id: "ready", name: "Ready" },
            { id: "doing", name: "Doing" },
          ],
          cards: [
            {
              id: "c-1",
              title: "P0 work",
              column: "doing",
              priority: "P0",
              updated: "2026-08-01T00:00:00Z",
              log: ["2026-08-01 agent: started"],
            },
            {
              id: "c-2",
              title: "Also doing",
              column: "doing",
              updated: "2026-08-01T00:00:00Z",
              log: [],
            },
            {
              id: "c-3",
              title: "Third",
              column: "doing",
              updated: "2026-08-01T00:00:00Z",
              log: [],
            },
            {
              id: "c-4",
              title: "Fourth",
              column: "doing",
              updated: "2026-08-01T00:00:00Z",
              log: [],
            },
          ],
          settings: { wipDoing: 3, wipHard: true },
        },
      ],
      { nowMs: now, staleHours: 48, silentHours: 12 },
    );
    expect(health.ok).toBe(false);
    expect(health.highCount).toBeGreaterThan(0);
    const kinds = new Set(health.issues.map((i) => i.kind));
    expect(kinds.has("p0_open")).toBe(true);
    expect(kinds.has("stale_doing")).toBe(true);
    expect(kinds.has("wip_over")).toBe(true);

    const digest = formatFleetDigest(health);
    expect(digest).toContain("NEEDS ATTENTION");
    expect(digest).toContain("P0");
    expect(digest).toContain("Hot");
    expect(digest).toMatch(/Issues:/);

    const payload = fleetWebhookPayload(health);
    expect(payload.ok).toBe(false);
    expect(payload.text).toContain("NEEDS ATTENTION");
    expect(payload.content).toBe(payload.text);
    expect(payload.highCount).toBe(health.highCount);
  });

  test("formatFleetDigest OK fleet", () => {
    const health = buildFleetHealth([
      {
        id: "quiet",
        title: "Quiet",
        columns: [{ id: "backlog", name: "B" }],
        cards: [
          {
            id: "c-q",
            title: "Later",
            column: "backlog",
            updated: "2026-08-05T11:00:00Z",
            log: [],
          },
        ],
      },
    ]);
    expect(health.ok).toBe(true);
    const digest = formatFleetDigest(health, { includeTiles: true });
    expect(digest).toContain("OK");
    expect(digest).toContain("Quiet");
  });
});
