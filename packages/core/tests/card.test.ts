import { describe, expect, test } from "bun:test";
import {
  countFrontmatterKey,
  parseCard,
  serializeCard,
  type Card,
} from "../src/card.ts";

const SAMPLE = `---
id: c-8f3a
title: Refactor auth middleware
column: doing
order: "0|hzzzzz:"
priority: P1
labels:
  - backend
  - security
assignee: claude
due: 2026-08-09
pr: mj/api-service#418
updated: 2026-08-04T12:53:00Z
---

## Status
Auth middleware split into validate/issue. Tests green.
JWT rotation still open — blocked on picking a key store.

## Log
- 2026-08-02 claude: created from issue #214
- 2026-08-03 claude: extracted validateSession()
- 2026-08-04 claude: tests green, 12 added
- 2026-08-04 claude: blocked — key store TBD
`;

describe("parseCard / serializeCard", () => {
  test("parseCard returns frontmatter, status, log for a valid card", () => {
    const r = parseCard(SAMPLE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.card.frontmatter.id).toBe("c-8f3a");
    expect(r.card.frontmatter.title).toBe("Refactor auth middleware");
    expect(r.card.frontmatter.column).toBe("doing");
    expect(r.card.frontmatter.order).toBe("0|hzzzzz:");
    expect(r.card.frontmatter.updated).toBe("2026-08-04T12:53:00Z");
    expect(r.card.frontmatter.labels).toEqual(["backend", "security"]);
    expect(r.card.status).toContain("Auth middleware split");
    expect(r.card.log.length).toBe(4);
    expect(r.card.log[0]).toContain("created from issue");
  });

  test("round-trip: parseCard(serializeCard(c)) deep-equals c", () => {
    const r = parseCard(SAMPLE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const text = serializeCard(r.card);
    const r2 = parseCard(text);
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.card.frontmatter.id).toBe(r.card.frontmatter.id);
    expect(r2.card.frontmatter.title).toBe(r.card.frontmatter.title);
    expect(r2.card.frontmatter.column).toBe(r.card.frontmatter.column);
    expect(r2.card.frontmatter.order).toBe(r.card.frontmatter.order);
    expect(r2.card.frontmatter.updated).toBe(r.card.frontmatter.updated);
    expect(r2.card.frontmatter.priority).toBe(r.card.frontmatter.priority);
    expect(r2.card.frontmatter.labels).toEqual(r.card.frontmatter.labels);
    expect(r2.card.frontmatter.assignee).toBe(r.card.frontmatter.assignee);
    expect(r2.card.frontmatter.due).toBe(r.card.frontmatter.due);
    expect(r2.card.frontmatter.pr).toBe(r.card.frontmatter.pr);
    expect(r2.card.status).toBe(r.card.status);
    expect(r2.card.log).toEqual(r.card.log);
  });

  test("invalid YAML returns typed parse error, never throws", () => {
    const bad = `---
id: [unterminated
title: x
---

## Status
hi
`;
    let threw = false;
    let r;
    try {
      r = parseCard(bad);
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(r!.ok).toBe(false);
    if (r!.ok) return;
    expect(r!.error.kind).toBe("parse_error");
    expect(r!.error.message.length).toBeGreaterThan(0);
  });

  test("duplicate frontmatter key column is a typed error, never throws", () => {
    const bad = `---
id: c-dup1
title: Dup
column: backlog
column: doing
order: "a0"
updated: 2026-08-04T00:00:00Z
---

## Status
x
`;
    let threw = false;
    let r;
    try {
      r = parseCard(bad);
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(r!.ok).toBe(false);
    if (r!.ok) return;
    expect(r!.error.kind).toBe("parse_error");
    // Either our raw-text detector or the YAML engine's unique-key error
    expect(r!.error.message.length).toBeGreaterThan(0);
    expect(
      /duplicate/i.test(r!.error.message) || /map keys must be unique|unique/i.test(r!.error.message),
    ).toBe(true);
  });

  test("Zod rejects empty required fields without throwing", () => {
    const bad = `---
id: ""
title: ""
column: ""
order: ""
updated: ""
---

## Status
x
`;
    const r = parseCard(bad);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("parse_error");
  });

  test("missing required fields returns typed error", () => {
    const bad = `---
title: only title
---

## Status
x
`;
    const r = parseCard(bad);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("parse_error");
  });

  test("missing ## Status or ## Log parse as empty, not errors", () => {
    const text = `---
id: c-abcd
title: Bare
column: backlog
order: "a0"
updated: 2026-08-04T00:00:00Z
---

Just some body without sections.
`;
    const r = parseCard(text);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.card.status).toBe("");
    expect(r.card.log).toEqual([]);
  });

  test("serialize never produces duplicate column: key", () => {
    const card: Card = {
      frontmatter: {
        id: "c-test",
        title: "T",
        column: "doing",
        order: "m",
        updated: "2026-08-04T00:00:00Z",
        labels: [],
      },
      status: "working",
      log: ["2026-08-04 human: created"],
    };
    const text = serializeCard(card);
    expect(countFrontmatterKey(text, "column")).toBe(1);
    expect(countFrontmatterKey(text, "id")).toBe(1);
    expect(countFrontmatterKey(text, "updated")).toBe(1);
  });
});
