import { describe, expect, test } from "bun:test";
import {
  contrastRatio,
  meetsWcagAa,
  validateThemeContrast,
  THEME_PALETTES,
  parseHexColor,
} from "../src/contrast.ts";
import {
  agentsMdConforms,
  agentCreateCard,
  validateAgentCard,
} from "../src/skill-conformance.ts";
import { boardsAgentsMd } from "../src/setup.ts";
import { parseCard } from "../src/card.ts";

describe("WCAG contrast (US-32 / NFR-8)", () => {
  test("parseHexColor + contrastRatio black/white = 21", () => {
    expect(parseHexColor("#fff")).toEqual({ r: 255, g: 255, b: 255 });
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 0);
    expect(meetsWcagAa("#000", "#fff")).toBe(true);
  });

  test("dark theme critical pairs meet AA", () => {
    const fails = validateThemeContrast("dark");
    expect(fails).toEqual([]);
  });

  test("light theme critical pairs meet AA", () => {
    const fails = validateThemeContrast("light");
    expect(fails).toEqual([]);
  });

  test("palette exports match CSS first-class colors", () => {
    expect(THEME_PALETTES.dark.text).toBe("#e8eaed");
    expect(THEME_PALETTES.light.bg).toBe("#f4f5f7");
    // muted on card still AA for both themes
    expect(
      meetsWcagAa(THEME_PALETTES.dark.muted, THEME_PALETTES.dark.card),
    ).toBe(true);
    expect(
      meetsWcagAa(THEME_PALETTES.light.muted, THEME_PALETTES.light.card),
    ).toBe(true);
  });
});

describe("skill / AGENTS.md conformance (US-9)", () => {
  test("boardsAgentsMd documents required contract sections", () => {
    const r = agentsMdConforms(boardsAgentsMd());
    expect(r.ok).toBe(true);
    expect(r.missing).toEqual([]);
  });

  test("simulated agent produces schema-valid cards with append order", () => {
    const existing: string[] = [];
    const orders: string[] = [];
    for (let i = 0; i < 5; i++) {
      const { card, markdown, filename } = agentCreateCard({
        title: `Agent task ${i}`,
        column: "backlog",
        existingIds: existing,
        columnOrders: orders,
        actor: "agent",
        labels: ["agent"],
      });
      existing.push(card.frontmatter.id);
      orders.push(card.frontmatter.order);

      expect(filename).toMatch(/^c-[a-z0-9]+-agent-task-/i);
      const check = validateAgentCard(markdown, {
        columnOrdersBefore: orders.slice(0, -1),
      });
      expect(check.ok).toBe(true);
      if (!check.ok) return;
      expect(check.card.frontmatter.column).toBe("backlog");
      expect(check.card.status).toBe("_Not started._");
      expect(check.card.log[0]).toMatch(/agent: created/);
    }
    // Strictly increasing orders
    for (let i = 1; i < orders.length; i++) {
      expect(orders[i]! > orders[i - 1]!).toBe(true);
    }
  });

  test("worked example in AGENTS.md parses as a valid card", () => {
    const md = boardsAgentsMd();
    const fence = md.match(/```markdown\n([\s\S]*?)```/);
    expect(fence).toBeTruthy();
    const parsed = parseCard(fence![1]!);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.card.frontmatter.id).toBe("c-8f3a");
    expect(parsed.card.frontmatter.column).toBe("doing");
  });
});
