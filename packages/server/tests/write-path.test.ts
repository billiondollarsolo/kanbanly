import { describe, expect, test, afterEach } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { parseCard, orderInitial } from "@kanbanly/core";
import { connectLocalRepo, refreshRepo } from "../src/connect.ts";
import { BoardIndexStore } from "../src/index-store.ts";
import { createHandler } from "../src/app.ts";
import {
  makeEmptyLayoutARepo,
  makeTempRepoFromFixture,
  git,
  readText,
  fileExists,
} from "./helpers.ts";

describe("createCard + moveCard via shipped write path (real git)", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  test("createCard writes markdown on disk and creates a git commit", async () => {
    const ctx = makeEmptyLayoutARepo();
    cleanups.push(ctx.cleanup);

    const store = new BoardIndexStore();
    const connected = await connectLocalRepo(ctx.repoPath, { indexStore: store });

    const created = await connected.storage.createCard(
      "backend",
      "Ship the landing page",
      "backlog",
      orderInitial(),
      { actor: "human" },
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const id = created.value.card.frontmatter.id;
    expect(id).toMatch(/^c-/);
    expect(created.value.sha).toMatch(/^[0-9a-f]{40}$/);

    // Filesystem: card markdown exists under backend/cards/
    const cardsDir = join(ctx.repoPath, "backend", "cards");
    const files = readdirSync(cardsDir).filter((f) => f.startsWith(`${id}-`) && f.endsWith(".md"));
    expect(files.length).toBe(1);
    const abs = join(cardsDir, files[0]!);
    expect(fileExists(abs)).toBe(true);

    const text = readText(abs);
    const parsed = parseCard(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.card.frontmatter.title).toBe("Ship the landing page");
    expect(parsed.card.frontmatter.column).toBe("backlog");
    expect(parsed.card.status).toBe("_Not started._");

    // git log has the create commit
    const log = git(ctx.repoPath, ["log", "-1", "--pretty=%s"]);
    expect(log.status).toBe(0);
    expect(log.stdout.trim()).toMatch(/^chore\(board\): create /);
    expect(log.stdout).toContain(id);
  });

  test("moveCard updates file column/order/log and commits", async () => {
    const ctx = makeEmptyLayoutARepo();
    cleanups.push(ctx.cleanup);

    const store = new BoardIndexStore();
    const connected = await connectLocalRepo(ctx.repoPath, { indexStore: store });

    const created = await connected.storage.createCard(
      "backend",
      "Move me please",
      "backlog",
      orderInitial(),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const id = created.value.card.frontmatter.id;

    const moved = await connected.storage.moveCard(
      "backend",
      id,
      "doing",
      "b0",
      { actor: "human" },
    );
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;

    const cardsDir = join(ctx.repoPath, "backend", "cards");
    const files = readdirSync(cardsDir).filter((f) => f.startsWith(`${id}-`));
    expect(files.length).toBe(1);
    const text = readText(join(cardsDir, files[0]!));
    const parsed = parseCard(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.card.frontmatter.column).toBe("doing");
    expect(parsed.card.frontmatter.order).toBe("b0");
    expect(parsed.card.log.some((l) => l.includes("moved backlog → doing"))).toBe(true);

    const log = git(ctx.repoPath, ["log", "-1", "--pretty=%s"]);
    expect(log.stdout.trim()).toMatch(/^chore\(board\): move /);
  });

  test("HTTP POST create + move go through handler and commit", async () => {
    const ctx = makeTempRepoFromFixture();
    cleanups.push(ctx.cleanup);

    const store = new BoardIndexStore();
    const connected = await connectLocalRepo(ctx.repoPath, { indexStore: store });
    const handler = createHandler({ connected, indexStore: store });

    // Create via API
    const createRes = await handler(
      new Request("http://127.0.0.1/api/boards/backend/cards", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "API-created card", column: "backlog" }),
      }),
    );
    expect(createRes.status).toBe(201);
    const createBody = (await createRes.json()) as {
      ok: boolean;
      card: { id: string; title: string; column: string };
      sha: string;
    };
    expect(createBody.ok).toBe(true);
    expect(createBody.card.title).toBe("API-created card");
    expect(createBody.card.column).toBe("backlog");
    expect(createBody.sha).toMatch(/^[0-9a-f]{40}$/);

    const cardId = createBody.card.id;
    const cardsDir = join(ctx.repoPath, "backend", "cards");
    const files = readdirSync(cardsDir).filter((f) => f.startsWith(`${cardId}-`));
    expect(files.length).toBe(1);

    // Move via API
    const moveRes = await handler(
      new Request(`http://127.0.0.1/api/boards/backend/cards/${cardId}/move`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ column: "review" }),
      }),
    );
    expect(moveRes.status).toBe(200);
    const moveBody = (await moveRes.json()) as { ok: boolean; column: string };
    expect(moveBody.ok).toBe(true);
    expect(moveBody.column).toBe("review");

    const text = readText(join(cardsDir, files[0]!));
    const parsed = parseCard(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.card.frontmatter.column).toBe("review");

    // Index refreshed
    await refreshRepo(connected, { indexStore: store, force: true });
    const board = store.getBoard(connected.remoteKey, "backend")!;
    expect(board.cardsByColumn["review"]!.some((c) => c.id === cardId)).toBe(true);

    // git log shows commits
    const log = git(ctx.repoPath, ["log", "--oneline"]);
    expect(log.stdout).toContain("create");
    expect(log.stdout).toContain("move");
  });

  test("create title-only card + move: filesystem markdown + multi-commit git log", async () => {
    // End-to-end via createHandler (shipped entry) against fixture layout A
    const ctx = makeTempRepoFromFixture();
    cleanups.push(ctx.cleanup);

    const store = new BoardIndexStore();
    const connected = await connectLocalRepo(ctx.repoPath, { indexStore: store });
    const handler = createHandler({ connected, indexStore: store });

    // Multi-board still visible
    const listRes = await handler(new Request("http://127.0.0.1/api/boards"));
    const listBody = (await listRes.json()) as {
      boards: Array<{ id: string }>;
    };
    expect(listBody.boards.map((b) => b.id).sort()).toEqual(["backend", "web"]);

    const createRes = await handler(
      new Request("http://127.0.0.1/api/boards/backend/cards", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Title only card", column: "backlog" }),
      }),
    );
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as {
      ok: boolean;
      card: { id: string; title: string; column: string };
    };
    expect(created.ok).toBe(true);
    expect(created.card.title).toBe("Title only card");
    const cardId = created.card.id;

    // Filesystem: markdown exists with title, default status
    const cardsDir = join(ctx.repoPath, "backend", "cards");
    const files = readdirSync(cardsDir).filter((f) => f.startsWith(`${cardId}-`) && f.endsWith(".md"));
    expect(files.length).toBe(1);
    const mdPath = join(cardsDir, files[0]!);
    expect(fileExists(mdPath)).toBe(true);
    const md = readText(mdPath);
    expect(md).toContain("title: Title only card");
    expect(md).toContain("column: backlog");
    const parsedCreate = parseCard(md);
    expect(parsedCreate.ok).toBe(true);
    if (!parsedCreate.ok) return;
    expect(parsedCreate.card.frontmatter.title).toBe("Title only card");
    expect(parsedCreate.card.status).toBe("_Not started._");

    const logAfterCreate = git(ctx.repoPath, ["log", "-1", "--pretty=%s"]);
    expect(logAfterCreate.stdout.trim()).toMatch(/^chore\(board\): create /);
    expect(logAfterCreate.stdout).toContain(cardId);

    const moveRes = await handler(
      new Request(`http://127.0.0.1/api/boards/backend/cards/${cardId}/move`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ column: "doing" }),
      }),
    );
    expect(moveRes.status).toBe(200);
    const moved = (await moveRes.json()) as { ok: boolean; column: string };
    expect(moved.ok).toBe(true);
    expect(moved.column).toBe("doing");

    const mdAfter = readText(mdPath);
    const parsedMove = parseCard(mdAfter);
    expect(parsedMove.ok).toBe(true);
    if (!parsedMove.ok) return;
    expect(parsedMove.card.frontmatter.column).toBe("doing");
    expect(parsedMove.card.log.some((l) => l.includes("moved backlog → doing"))).toBe(true);

    const fullLog = git(ctx.repoPath, ["log", "--pretty=%s"]);
    expect(fullLog.stdout).toMatch(/chore\(board\): create /);
    expect(fullLog.stdout).toMatch(/chore\(board\): move /);
    expect(fullLog.stdout).toContain(cardId);
  });
});
