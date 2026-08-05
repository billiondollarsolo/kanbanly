import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { GitStorage } from "../src/storage/git.ts";
import { defaultBoardYaml } from "../src/board.ts";
import { parseCard } from "../src/card.ts";
import { orderAfter, orderInitial } from "../src/order.ts";

function git(cwd: string, args: string[]) {
  return spawnSync("git", args, { cwd, encoding: "utf8" });
}

function makeBareAndClone(): { bare: string; cloneA: string; cloneB: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), "kanbanly-git-"));
  const bare = join(root, "remote.git");
  const cloneA = join(root, "clone-a");
  const cloneB = join(root, "clone-b");

  mkdirSync(bare, { recursive: true });
  git(bare, ["init", "--bare"]);

  // Seed via a temp clone
  const seed = join(root, "seed");
  git(root, ["clone", bare, seed]);
  git(seed, ["config", "user.name", "seed"]);
  git(seed, ["config", "user.email", "seed@test"]);
  mkdirSync(join(seed, "backend", "cards"), { recursive: true });
  writeFileSync(join(seed, "backend", "board.yml"), defaultBoardYaml());
  writeFileSync(join(seed, "README.md"), "# boards\n");
  git(seed, ["add", "."]);
  git(seed, ["commit", "-m", "init boards"]);
  git(seed, ["branch", "-M", "main"]);
  git(seed, ["push", "-u", "origin", "main"]);

  git(root, ["clone", bare, cloneA]);
  git(cloneA, ["config", "user.name", "a"]);
  git(cloneA, ["config", "user.email", "a@test"]);
  git(root, ["clone", bare, cloneB]);
  git(cloneB, ["config", "user.name", "b"]);
  git(cloneB, ["config", "user.email", "b@test"]);

  return { bare, cloneA, cloneB, root };
}

describe("GitStorage (real git, not mocked)", () => {
  let ctx: ReturnType<typeof makeBareAndClone>;

  beforeEach(() => {
    ctx = makeBareAndClone();
  });

  afterEach(() => {
    try {
      rmSync(ctx.root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  test("listBoards + readBoard from layout A", async () => {
    const storage = new GitStorage({ repoPath: ctx.cloneA });
    const boards = await storage.listBoards();
    expect(boards.ok).toBe(true);
    if (!boards.ok) return;
    expect(boards.value.some((b) => b.id === "backend")).toBe(true);

    const board = await storage.readBoard("backend");
    expect(board.ok).toBe(true);
    if (!board.ok) return;
    expect(board.value.columns.length).toBeGreaterThan(0);
  });

  test("writeCard commits with chore(board): message and returns SHA", async () => {
    const storage = new GitStorage({
      repoPath: ctx.cloneA,
      authorName: "a",
      authorEmail: "a@test",
    });
    const created = await storage.createCard(
      "backend",
      "First card",
      "backlog",
      orderInitial(),
      { actor: "human" },
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(created.value.card.frontmatter.id).toMatch(/^c-/);

    const log = git(ctx.cloneA, ["log", "-1", "--pretty=%s"]);
    expect(log.stdout).toMatch(/^chore\(board\):/);

    // File exists on disk
    const listed = await storage.listCards("backend");
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value.length).toBe(1);
    const path = join(ctx.cloneA, listed.value[0]!.path);
    expect(existsSync(path)).toBe(true);
    const text = readFileSync(path, "utf8");
    const parsed = parseCard(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.card.frontmatter.title).toBe("First card");
    expect(parsed.card.status).toBe("_Not started._");
  });

  test("moveCard updates column, order, log, and commits", async () => {
    const storage = new GitStorage({ repoPath: ctx.cloneA });
    const created = await storage.createCard(
      "backend",
      "Move me",
      "backlog",
      orderInitial(),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const id = created.value.card.frontmatter.id;

    const moved = await storage.moveCard(
      "backend",
      id,
      "doing",
      orderAfter(orderInitial()),
      { actor: "human" },
    );
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;

    const read = await storage.readCard("backend", id);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.frontmatter.column).toBe("doing");
    expect(read.value.log.some((l) => l.includes("moved backlog → doing"))).toBe(true);
  });

  test("push with rebase-retry against real bare remote", async () => {
    const a = new GitStorage({
      repoPath: ctx.cloneA,
      remoteUrl: ctx.bare,
      maxPushRetries: 3,
    });
    const b = new GitStorage({
      repoPath: ctx.cloneB,
      remoteUrl: ctx.bare,
      maxPushRetries: 3,
    });

    // Ensure origin is set
    a.git(["remote", "remove", "origin"]);
    a.git(["remote", "add", "origin", ctx.bare]);
    b.git(["remote", "remove", "origin"]);
    b.git(["remote", "add", "origin", ctx.bare]);

    const c1 = await a.createCard("backend", "From A", "backlog", orderInitial());
    expect(c1.ok).toBe(true);
    const pushA = await a.push();
    expect(pushA.ok).toBe(true);

    // B is behind — create local commit then push should rebase-retry
    const c2 = await b.createCard(
      "backend",
      "From B",
      "backlog",
      orderAfter(orderInitial()),
    );
    expect(c2.ok).toBe(true);
    const pushB = await b.push();
    // Should succeed after rebase (non-overlapping files)
    expect(pushB.ok).toBe(true);
    if (!pushB.ok) {
      console.error(pushB.error);
    }
  });

  test("push returns typed conflict when same-file divergence cannot rebase", async () => {
    const a = new GitStorage({
      repoPath: ctx.cloneA,
      remoteUrl: ctx.bare,
      maxPushRetries: 3,
    });
    const b = new GitStorage({
      repoPath: ctx.cloneB,
      remoteUrl: ctx.bare,
      maxPushRetries: 3,
    });

    a.git(["remote", "remove", "origin"]);
    a.git(["remote", "add", "origin", ctx.bare]);
    b.git(["remote", "remove", "origin"]);
    b.git(["remote", "add", "origin", ctx.bare]);

    // Shared card on remote
    const created = await a.createCard(
      "backend",
      "Shared conflict",
      "backlog",
      orderInitial(),
      { actor: "a" },
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const id = created.value.card.frontmatter.id;
    expect((await a.push()).ok).toBe(true);

    // B fetches the shared card
    b.git(["fetch", "origin", "main"]);
    const pullB = b.git(["pull", "--rebase", "origin", "main"]);
    if (!pullB.ok) {
      // Allow already-up-to-date; otherwise surface stderr for diagnosis
      const combined = `${pullB.stdout}\n${pullB.stderr}`;
      expect(combined).toMatch(/up to date|Already up to date/i);
    }
    // Card must exist on B after sync
    const onB = await b.readCard("backend", id);
    expect(onB.ok).toBe(true);

    // A moves and pushes first
    const moveA = await a.moveCard("backend", id, "doing", orderAfter(orderInitial()), {
      actor: "a",
    });
    expect(moveA.ok).toBe(true);
    expect((await a.push()).ok).toBe(true);

    // B diverges on the same card without pulling A's move
    const moveB = await b.moveCard("backend", id, "review", orderAfter(orderInitial()), {
      actor: "b",
    });
    expect(moveB.ok).toBe(true);

    const pushB = await b.push();
    expect(pushB.ok).toBe(false);
    if (pushB.ok) return;
    expect(pushB.error.kind).toBe("conflict");
    expect(pushB.error.message.length).toBeGreaterThan(0);
    // Spec: typed conflict names the diverged files
    expect("files" in pushB.error).toBe(true);
    const files = "files" in pushB.error ? (pushB.error.files ?? []) : [];
    expect(files.length).toBeGreaterThan(0);
    expect(files.some((f) => f.includes(id) || f.includes("cards/") || f.endsWith(".md"))).toBe(
      true,
    );
  });

  test("GitStorage.clone opens a real clone for list/read", async () => {
    // Seed a card on the bare remote via cloneA
    const seeder = new GitStorage({
      repoPath: ctx.cloneA,
      remoteUrl: ctx.bare,
    });
    seeder.git(["remote", "remove", "origin"]);
    seeder.git(["remote", "add", "origin", ctx.bare]);
    const created = await seeder.createCard(
      "backend",
      "Clone read me",
      "backlog",
      orderInitial(),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const id = created.value.card.frontmatter.id;
    expect((await seeder.push()).ok).toBe(true);

    const dest = join(ctx.root, "cloned-via-api");
    const storage = GitStorage.clone(ctx.bare, dest);
    expect(existsSync(join(dest, ".git"))).toBe(true);

    const boards = await storage.listBoards();
    expect(boards.ok).toBe(true);
    if (!boards.ok) return;
    expect(boards.value.some((b) => b.id === "backend")).toBe(true);

    const board = await storage.readBoard("backend");
    expect(board.ok).toBe(true);

    const card = await storage.readCard("backend", id);
    expect(card.ok).toBe(true);
    if (!card.ok) return;
    expect(card.value.frontmatter.title).toBe("Clone read me");

    // Re-open is idempotent (already cloned)
    const again = GitStorage.clone(ctx.bare, dest);
    expect(again.repoPath).toBe(dest);
  });

  test("initLocal creates a usable repo", async () => {
    const path = join(ctx.root, "local-only");
    const storage = GitStorage.initLocal(path);
    mkdirSync(join(path, "cards"), { recursive: true });
    writeFileSync(join(path, "board.yml"), defaultBoardYaml());
    storage.git(["add", "."]);
    storage.git(["commit", "-m", "init"]);
    const boards = await storage.listBoards();
    expect(boards.ok).toBe(true);
  });
});
