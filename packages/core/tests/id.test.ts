import { describe, expect, test } from "bun:test";
import {
  cardFilename,
  DEFAULT_ID_HEX_LENGTH,
  generateBoardId,
  generateCardId,
  slugifyTitle,
} from "../src/id.ts";

describe("generateCardId", () => {
  test("returns c- + 24 hex chars (Trello-style) by default", () => {
    const id = generateCardId([]);
    expect(id).toMatch(new RegExp(`^c-[0-9a-f]{${DEFAULT_ID_HEX_LENGTH}}$`));
  });

  test("retries on collision with seeded generator", () => {
    // Sequence: first three generate all "a", fourth generates all "b"
    let n = 0;
    const forced = () => {
      const phase = Math.floor(n / 8); // 8 hex chars per attempt at length 8
      n++;
      if (phase < 3) {
        return 10 / 16 + 0.0001; // 'a'
      }
      return 11 / 16 + 0.0001; // 'b'
    };
    const existing = new Set<string>(["c-aaaaaaaa"]);
    n = 0;
    const id = generateCardId(existing, { random: forced, length: 8 });
    expect(id).toBe("c-bbbbbbbb");
    expect(n).toBeGreaterThan(8);
  });

  test("avoids all existing ids", () => {
    const existing = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const id = generateCardId(existing);
      expect(existing.has(id)).toBe(false);
      existing.add(id);
    }
    expect(existing.size).toBe(50);
  });

  test("rejects invalid length", () => {
    expect(() => generateCardId([], { length: 4 })).toThrow(/8–32/);
  });
});

describe("generateBoardId", () => {
  test("returns b- + 24 hex chars by default", () => {
    const id = generateBoardId([]);
    expect(id).toMatch(new RegExp(`^b-[0-9a-f]{${DEFAULT_ID_HEX_LENGTH}}$`));
  });

  test("unique across many draws", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const id = generateBoardId(ids);
      expect(id).toMatch(/^b-[0-9a-f]{24}$/);
      ids.add(id);
    }
    expect(ids.size).toBe(20);
  });
});

describe("cardFilename / slugify", () => {
  test("cardFilename returns <id>-<slug>.md", () => {
    expect(cardFilename("c-8f3a", "Refactor auth middleware")).toBe(
      "c-8f3a-refactor-auth-middleware.md",
    );
  });

  test("slugification handles unicode, punctuation, long titles", () => {
    expect(slugifyTitle("Hello, World!")).toBe("hello-world");
    expect(slugifyTitle("Café résumé")).toBe("cafe-resume");
    const long = "a".repeat(200);
    expect(slugifyTitle(long).length).toBeLessThanOrEqual(80);
    expect(slugifyTitle("!!!")).toBe("card");
  });
});
