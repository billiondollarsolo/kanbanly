import { describe, expect, test } from "bun:test";
import { cardFilename, generateCardId, slugifyTitle } from "../src/id.ts";

describe("generateCardId", () => {
  test("returns c- + 4–6 base36 chars not in existingIds", () => {
    const id = generateCardId([]);
    expect(id).toMatch(/^c-[0-9a-z]{4,6}$/);
  });

  test("retries on collision with seeded generator forcing 3 collisions", () => {
    // Sequence: first three generate "aaaa", fourth generates "bbbb"
    let n = 0;
    const forced = () => {
      // Math.floor(random * 36) — return value that maps to 'a' (10) or 'b' (11)
      // char index 10 = 'a', 11 = 'b'
      const phase = Math.floor(n / 4); // 4 chars per id
      const charPos = n % 4;
      n++;
      if (phase < 3) {
        // always 'a' → id c-aaaa
        return 10 / 36 + 0.0001;
      }
      // then 'b' → c-bbbb
      return 11 / 36 + 0.0001;
    };
    // Also need existing to include c-aaaa so first 3 collide
    const existing = new Set<string>(["c-aaaa"]);
    // Actually our generator will produce c-aaaa three times then c-bbbb
    // Wait: each generateCardId call retries internally. So one call with
    // existing {c-aaaa} and random that produces aaaa then bbbb works.
    n = 0;
    const id = generateCardId(existing, { random: forced, length: 4 });
    expect(id).toBe("c-bbbb");
    // We used more than 4 random draws (collision retries)
    expect(n).toBeGreaterThan(4);
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
