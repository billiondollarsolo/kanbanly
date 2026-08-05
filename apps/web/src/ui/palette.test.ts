import { describe, expect, test } from "bun:test";
import {
  ACCENT_PALETTE,
  columnAccent,
  columnAccents,
  hashKey,
  initialsOf,
  labelColor,
  paletteFor,
} from "./palette.ts";

/** Raw (pre-collision-resolution) slot a key hashes to. */
const slot = (key: string) => hashKey(key) % ACCENT_PALETTE.length;

describe("paletteFor", () => {
  test("is stable for the same key", () => {
    expect(paletteFor("doing")).toBe(paletteFor("doing"));
  });

  test("always returns a palette entry", () => {
    for (const id of ["backlog", "doing", "review", "done", "", "…"]) {
      expect(ACCENT_PALETTE).toContain(paletteFor(id));
    }
  });

  test("ASCII case never changes the hue, though it does change the hash", () => {
    // The slot is hash % 8, i.e. the low three bits, and the ASCII case bit
    // (0x20) cannot propagate down into them through FNV-1a's multiply. So
    // labelColor's toLowerCase() is belt-and-braces for ASCII labels.
    expect(hashKey("Done")).not.toBe(hashKey("done"));
    expect(paletteFor("Done")).toBe(paletteFor("done"));
  });

  test("columnAccent is the column-id spelling of paletteFor", () => {
    expect(columnAccent("backlog")).toBe(paletteFor("backlog"));
  });

  test("labelColor lower-cases first, so label casing does not fork the hue", () => {
    expect(labelColor("Bug")).toBe(labelColor("bug"));
    expect(labelColor("BUG")).toBe(paletteFor("bug"));
  });
});

describe("columnAccents collision resolution", () => {
  // These four ids all hash to the same raw slot (1) — the exact case the
  // walk-to-the-next-free-slot rule exists for.
  const COLLIDING = ["review", "done", "triage", "icebox"];

  test("the fixture really does collide before resolution", () => {
    expect(COLLIDING.map(slot)).toEqual([1, 1, 1, 1]);
  });

  test("colliding columns end up with distinct accents", () => {
    const out = columnAccents(COLLIDING);
    expect(new Set(Object.values(out)).size).toBe(COLLIDING.length);
  });

  test("the first claimant keeps its plain-hash colour", () => {
    const out = columnAccents(COLLIDING);
    expect(out.review).toBe(paletteFor("review"));
  });

  test("later claimants walk to the next free slot, in order", () => {
    const out = columnAccents(COLLIDING);
    expect(out.done).toBe(ACCENT_PALETTE[2]);
    expect(out.triage).toBe(ACCENT_PALETTE[3]);
    expect(out.icebox).toBe(ACCENT_PALETTE[4]);
  });

  test("assignment follows column order, not id", () => {
    const out = columnAccents(["done", "review"]);
    expect(out.done).toBe(ACCENT_PALETTE[1]);
    expect(out.review).toBe(ACCENT_PALETTE[2]);
  });

  test("the walk wraps past the end of the palette", () => {
    // "qa" and "design" both hash to the last slot (7); the second wraps to 0.
    expect([slot("qa"), slot("design")]).toEqual([7, 7]);
    const out = columnAccents(["qa", "design"]);
    expect(out.qa).toBe(ACCENT_PALETTE[7]);
    expect(out.design).toBe(ACCENT_PALETTE[0]);
  });

  test("non-colliding columns are untouched by the walk", () => {
    const out = columnAccents(["backlog", "doing"]);
    expect(out.backlog).toBe(paletteFor("backlog"));
    expect(out.doing).toBe(paletteFor("doing"));
  });
});

describe("columnAccents palette exhaustion", () => {
  const NINE = [
    "backlog",
    "doing",
    "review",
    "done",
    "blocked",
    "triage",
    "in-review",
    "icebox",
    "ready",
  ];

  test("the first eight columns use every palette entry exactly once", () => {
    const out = columnAccents(NINE.slice(0, 8));
    expect(new Set(Object.values(out))).toEqual(new Set(ACCENT_PALETTE));
  });

  test("once the palette is full it falls back to plain hashing", () => {
    const out = columnAccents(NINE);
    expect(out.ready).toBe(paletteFor("ready"));
  });

  test("beyond eight, duplicate hues are allowed again", () => {
    const out = columnAccents([...NINE, "shipped"]);
    // "ready" and "shipped" both hash to slot 4 and neither can walk.
    expect(out.shipped).toBe(out.ready);
  });
});

describe("columnAccents general behaviour", () => {
  test("is deterministic for the same column set", () => {
    const ids = ["backlog", "doing", "review", "done"];
    expect(columnAccents(ids)).toEqual(columnAccents(ids));
  });

  test("covers every id it is given", () => {
    const ids = ["a", "b", "c"];
    expect(Object.keys(columnAccents(ids))).toEqual(ids);
  });

  test("no columns is an empty map", () => {
    expect(columnAccents([])).toEqual({});
  });

  test("a repeated id collides with itself and the last write wins", () => {
    // Not a case real boards hit (column ids are unique) but worth pinning:
    // the second occurrence is treated as a colliding column, walks to the
    // next free slot, and overwrites the entry the first one claimed.
    const out = columnAccents(["review", "review"]);
    expect(out.review).toBe(ACCENT_PALETTE[2]);
  });
});

describe("initialsOf", () => {
  test("two names give one letter each", () => {
    expect(initialsOf("Rina Kovacs")).toBe("RK");
  });

  test("a single name gives its first two letters", () => {
    expect(initialsOf("claude")).toBe("CL");
  });

  test("only the first two words count", () => {
    expect(initialsOf("mary jane watson")).toBe("MJ");
  });

  test("surrounding and inner whitespace is ignored", () => {
    expect(initialsOf("  mj  ")).toBe("MJ");
    expect(initialsOf("Rina   Kovacs")).toBe("RK");
  });

  test("a one-letter name is not padded", () => {
    expect(initialsOf("a")).toBe("A");
  });

  test("an empty name falls back to a placeholder", () => {
    expect(initialsOf("")).toBe("?");
    expect(initialsOf("   ")).toBe("?");
  });
});
