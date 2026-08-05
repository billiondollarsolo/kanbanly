/**
 * Quarantine: malformed frontmatter + unknown column (real git).
 */
import { describe, expect, test, afterEach } from "bun:test";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { connectLocalRepo } from "../src/connect.ts";
import { BoardIndexStore } from "../src/index-store.ts";
import { startServer } from "../src/app.ts";
import { freePort, makeEmptyLayoutARepo } from "./helpers.ts";

function git(cwd: string, args: string[]) {
  return spawnSync("git", args, { cwd, encoding: "utf8" });
}

describe("quarantine lanes", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  test("malformed card is quarantined; board still loads known cards", async () => {
    const ctx = makeEmptyLayoutARepo();
    cleanups.push(ctx.cleanup);
    const cardsDir = join(ctx.repoPath, "backend", "cards");
    mkdirSync(cardsDir, { recursive: true });

    // Valid card
    writeFileSync(
      join(cardsDir, "c-good-ok.md"),
      `---
id: c-good
title: Good card
column: backlog
order: "a0"
updated: 2026-08-04T00:00:00Z
---

## Status
ok

## Log
- 2026-08-04 human: created
`,
    );

    // Malformed YAML (invalid) but matching filename pattern
    writeFileSync(
      join(cardsDir, "c-bad1-broken.md"),
      `---
id: [not valid
title: Broken
column: backlog
---
## Status
x
`,
    );

    git(ctx.repoPath, ["add", "."]);
    git(ctx.repoPath, ["commit", "-m", "seed quarantine"]);

    const store = new BoardIndexStore();
    const connected = await connectLocalRepo(ctx.repoPath, { indexStore: store });
    const board = store.getBoard(connected.remoteKey, "backend");
    expect(board).toBeTruthy();
    expect(board!.cards.some((c) => c.id === "c-good")).toBe(true);
    expect(board!.quarantine.some((q) => q.kind === "parse_error")).toBe(true);

    const port = await freePort();
    const server = startServer({
      host: "127.0.0.1",
      port,
      connected,
      indexStore: store,
      startLive: false,
      enablePushQueue: false,
    });
    cleanups.push(() => server.stop(true));

    const res = await fetch(`http://127.0.0.1:${port}/api/boards/backend`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      cards: Array<{ id: string }>;
      parseErrors: Array<{ kind: string; message: string }>;
      quarantine: Array<{ kind: string }>;
    };
    expect(body.cards.some((c) => c.id === "c-good")).toBe(true);
    expect(body.parseErrors.length).toBeGreaterThan(0);
    expect(body.quarantine.some((q) => q.kind === "parse_error")).toBe(true);
  });

  test("unknown column quarantined; remap moves all to known column", async () => {
    const ctx = makeEmptyLayoutARepo();
    cleanups.push(ctx.cleanup);
    const cardsDir = join(ctx.repoPath, "backend", "cards");
    mkdirSync(cardsDir, { recursive: true });

    writeFileSync(
      join(cardsDir, "c-qa01-in-qa.md"),
      `---
id: c-qa01
title: QA card one
column: qa
order: "a0"
updated: 2026-08-04T00:00:00Z
---

## Status
waiting

## Log
- 2026-08-04 human: created
`,
    );
    writeFileSync(
      join(cardsDir, "c-qa02-in-qa.md"),
      `---
id: c-qa02
title: QA card two
column: qa
order: "a1"
updated: 2026-08-04T00:00:00Z
---

## Status
waiting

## Log
- 2026-08-04 human: created
`,
    );
    git(ctx.repoPath, ["add", "."]);
    git(ctx.repoPath, ["commit", "-m", "unknown col"]);

    const store = new BoardIndexStore();
    const connected = await connectLocalRepo(ctx.repoPath, { indexStore: store });
    const port = await freePort();
    const server = startServer({
      host: "127.0.0.1",
      port,
      connected,
      indexStore: store,
      startLive: false,
      enablePushQueue: false,
    });
    cleanups.push(() => server.stop(true));

    const before = await fetch(`http://127.0.0.1:${port}/api/boards/backend`);
    const b1 = (await before.json()) as {
      unknownColumns: string[];
      unknownByColumn: Record<string, Array<{ id: string }>>;
      cardsByColumn: Record<string, unknown[]>;
    };
    expect(b1.unknownColumns).toContain("qa");
    expect(b1.unknownByColumn.qa?.length).toBe(2);
    // Not in normal backlog lane
    expect(b1.cardsByColumn.backlog?.length ?? 0).toBe(0);

    const remap = await fetch(
      `http://127.0.0.1:${port}/api/boards/backend/remap-column`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ from: "qa", to: "review" }),
      },
    );
    expect(remap.status).toBe(200);
    const rbody = (await remap.json()) as { remapped: string[] };
    expect(rbody.remapped.length).toBe(2);

    const after = await fetch(`http://127.0.0.1:${port}/api/boards/backend`);
    const b2 = (await after.json()) as {
      unknownColumns: string[];
      cardsByColumn: Record<string, Array<{ id: string }>>;
    };
    expect(b2.unknownColumns ?? []).not.toContain("qa");
    expect(b2.cardsByColumn.review?.map((c) => c.id).sort()).toEqual([
      "c-qa01",
      "c-qa02",
    ]);

    const log = spawnSync("git", ["log", "-1", "--pretty=%s"], {
      cwd: ctx.repoPath,
      encoding: "utf8",
    });
    expect(log.stdout).toMatch(/remap/);
  });
});
