import { describe, expect, test } from "bun:test";
import { parseCard, serializeCard, type Card } from "../src/card.ts";
import { mergeChecklist } from "../src/merge.ts";

const FM = `---
id: c-1
title: A card
column: doing
order: "a0"
updated: 2026-08-05T00:00:00Z
---
`;

function parse(body: string): Card {
  const r = parseCard(FM + "\n" + body);
  if (!r.ok) throw new Error(r.error.message);
  return r.card;
}

describe("checklist parsing", () => {
  test("reads GFM task items and their state", () => {
    const c = parse(`## Status
Working.

## Checklist
- [x] first
- [ ] second

## Log
- 2026-08-05 mj: created
`);
    expect(c.checklist).toEqual([
      { text: "first", done: true },
      { text: "second", done: false },
    ]);
    // Neighbouring sections stay intact.
    expect(c.status).toBe("Working.");
    expect(c.log).toEqual(["2026-08-05 mj: created"]);
  });

  test("uppercase [X] counts as done", () => {
    expect(parse("## Checklist\n- [X] done it\n").checklist).toEqual([
      { text: "done it", done: true },
    ]);
  });

  test("a plain bullet is treated as unchecked", () => {
    // Agents write these; better to adopt than to silently drop.
    expect(parse("## Checklist\n- plain item\n").checklist).toEqual([
      { text: "plain item", done: false },
    ]);
  });

  test("missing section yields an empty checklist", () => {
    expect(parse("## Status\nhi\n\n## Log\n- x\n").checklist).toEqual([]);
  });

  test("an unknown heading stays inside Status rather than being dropped", () => {
    const c = parse(`## Status
intro

## Notes
kept

## Log
- 2026-08-05 mj: created
`);
    expect(c.status).toContain("## Notes");
    expect(c.status).toContain("kept");
  });
});

describe("checklist serialization", () => {
  test("round-trips through serialize → parse", () => {
    const card = parse("## Status\nhi\n\n## Checklist\n- [x] a\n- [ ] b\n\n## Log\n- 2026-08-05 mj: x\n");
    const again = parseCard(serializeCard(card));
    if (!again.ok) throw new Error(again.error.message);
    expect(again.card.checklist).toEqual(card.checklist);
    expect(again.card.status).toBe(card.status);
    expect(again.card.log).toEqual(card.log);
  });

  test("emits no ## Checklist section when empty", () => {
    const card = parse("## Status\nhi\n\n## Log\n- 2026-08-05 mj: x\n");
    // Existing cards must not all gain an empty section (and a diff) on write.
    expect(serializeCard(card)).not.toContain("## Checklist");
  });

  test("writes GFM task syntax", () => {
    const card = parse("## Checklist\n- [x] a\n- [ ] b\n");
    const out = serializeCard(card);
    expect(out).toContain("- [x] a");
    expect(out).toContain("- [ ] b");
  });
});

describe("mergeChecklist", () => {
  const i = (text: string, done = false) => ({ text, done });

  test("ticking on one side is not duplicated as two items", () => {
    const base = [i("a")];
    const ours = [i("a", true)];
    const theirs = [i("a")];
    expect(mergeChecklist(ours, theirs, base)).toEqual([i("a", true)]);
  });

  test("checked wins when the two sides disagree", () => {
    expect(mergeChecklist([i("a")], [i("a", true)], [i("a")])).toEqual([
      i("a", true),
    ]);
  });

  test("items added on either side are unioned", () => {
    const merged = mergeChecklist([i("a"), i("b")], [i("a"), i("c")], [i("a")]);
    expect(merged.map((x) => x.text).sort()).toEqual(["a", "b", "c"]);
  });

  test("an item deleted on one side and untouched on the other stays deleted", () => {
    const merged = mergeChecklist([i("a")], [i("a"), i("b")], [i("a"), i("b")]);
    expect(merged.map((x) => x.text)).toEqual(["a"]);
  });

  test("deleting on both sides removes it", () => {
    expect(mergeChecklist([i("a")], [i("a")], [i("a"), i("b")])).toEqual([
      i("a"),
    ]);
  });

  test("empty on both sides stays empty", () => {
    expect(mergeChecklist([], [], [])).toEqual([]);
  });
});

describe("checklist round-trip is lossless (regression guards)", () => {
  const withProse = `## Status
hi

## Checklist
Some prose explaining the checklist.
- [ ] parent
  - [ ] nested child
More prose after.

## Log
- 2026-08-05 mj: x
`;

  test("an unrelated write does not touch the checklist section", () => {
    const card = parse(withProse);
    card.status = "edited elsewhere";
    const section = serializeCard(card).split("## Checklist")[1]!.split("## Log")[0]!;
    // Both prose lines and the nesting must survive a write of another field.
    expect(section).toContain("Some prose explaining the checklist.");
    expect(section).toContain("More prose after.");
    expect(section).toContain("  - [ ] nested child");
  });

  test("nesting survives an actual checklist edit", () => {
    const card = parse("## Checklist\n- [ ] parent\n  - [ ] child\n");
    card.checklist = card.checklist.map((i) =>
      i.text === "child" ? { ...i, done: true } : i,
    );
    const out = serializeCard(card);
    expect(out).toContain("  - [x] child");
    expect(out).toContain("- [ ] parent");
  });

  test("a ## Checklist heading inside Status no longer deletes the text under it", () => {
    const card = parse(`## Status
Intro paragraph.

## Checklist
these two prose lines
should not vanish

## Log
- 2026-08-05 mj: x
`);
    const out = serializeCard(card);
    expect(out).toContain("these two prose lines");
    expect(out).toContain("should not vanish");
  });
});

describe("mergeChecklist duplicate handling", () => {
  const i = (text: string, done = false) => ({ text, done });

  test("two items with the same text stay two items", () => {
    const dup = [i("review", true), i("review")];
    expect(mergeChecklist(dup, dup, dup)).toEqual([i("review", true), i("review")]);
  });

  test("the nth occurrence keeps its own done state", () => {
    const base = [i("test"), i("test")];
    const ours = [i("test", true), i("test")];
    expect(mergeChecklist(ours, base, base)).toEqual([i("test", true), i("test")]);
  });
});
