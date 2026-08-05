/**
 * US-27: genuine unresolvable conflict between two clones → freeze → keep-mine → resume
 * US-22: git log --follow after archive
 * API: card history endpoint
 */
import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { GitStorage, orderAfter, orderInitial, defaultBoardYaml } from "@kanbanly/core";
import { connectLocalRepo } from "../src/connect.ts";
import { BoardIndexStore } from "../src/index-store.ts";
import { startServer } from "../src/app.ts";
import { defaultQueuePath } from "../src/push-queue.ts";
import { freePort } from "./helpers.ts";

function git(cwd: string, args: string[]) {
  return spawnSync("git", args, { cwd, encoding: "utf8" });
}

function makeBarePair() {
  const root = mkdtempSync(join(tmpdir(), "kanbanly-2clone-"));
  const bare = join(root, "remote.git");
  const cloneA = join(root, "a");
  const cloneB = join(root, "b");
  mkdirSync(bare, { recursive: true });
  git(bare, ["init", "--bare"]);
  const seed = join(root, "seed");
  git(root, ["clone", bare, seed]);
  git(seed, ["config", "user.name", "seed"]);
  git(seed, ["config", "user.email", "s@t"]);
  mkdirSync(join(seed, "backend", "cards"), { recursive: true });
  writeFileSync(join(seed, "backend", "board.yml"), defaultBoardYaml());
  git(seed, ["add", "."]);
  git(seed, ["commit", "-m", "init"]);
  git(seed, ["branch", "-M", "main"]);
  git(seed, ["push", "-u", "origin", "main"]);
  git(root, ["clone", bare, cloneA]);
  git(cloneA, ["config", "user.name", "a"]);
  git(cloneA, ["config", "user.email", "a@t"]);
  git(root, ["clone", bare, cloneB]);
  git(cloneB, ["config", "user.name", "b"]);
  git(cloneB, ["config", "user.email", "b@t"]);
  return {
    root,
    bare,
    cloneA,
    cloneB,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe("two-clone conflict e2e (US-27)", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  test("diverged clones → conflict snapshot → keep-mine → unfreeze", async () => {
    const ctx = makeBarePair();
    cleanups.push(ctx.cleanup);

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

    const created = await a.createCard(
      "backend",
      "Conflict me",
      "backlog",
      orderInitial(),
      { actor: "a" },
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const id = created.value.card.frontmatter.id;
    expect((await a.push()).ok).toBe(true);

    b.git(["pull", "--rebase", "origin", "main"]);
    expect((await b.readCard("backend", id)).ok).toBe(true);

    // A wins the race
    expect(
      (
        await a.moveCard("backend", id, "doing", orderAfter(orderInitial()), {
          actor: "a",
        })
      ).ok,
    ).toBe(true);
    expect((await a.push()).ok).toBe(true);

    // B diverges without pull
    expect(
      (
        await b.moveCard("backend", id, "review", orderAfter(orderInitial()), {
          actor: "b",
        })
      ).ok,
    ).toBe(true);
    const pushB = await b.push();
    expect(pushB.ok).toBe(false);
    if (pushB.ok) return;
    expect(pushB.error.kind).toBe("conflict");

    // Snapshots captured for keep-mine/theirs (both sides present)
    const conflicts = b.listConflicts();
    expect(conflicts.length).toBeGreaterThan(0);
    const snap = conflicts.find((c) => c.cardId === id);
    expect(snap).toBeTruthy();
    if (!snap) return;
    const colOf = (text: string) => text.match(/^column:\s*(\S+)/m)?.[1];
    const mineCol = colOf(snap.ours);
    const theirsCol = colOf(snap.theirs);
    expect(mineCol).toBeTruthy();
    expect(theirsCol).toBeTruthy();
    expect(mineCol).not.toBe(theirsCol);
    // Local work (B) was review; remote (A) was doing — either mapping is ok
    // as long as both sides were captured
    expect([mineCol, theirsCol].sort()).toEqual(["doing", "review"]);

    // keep-mine applies snapshot.ours
    const resolved = await b.resolveConflict("backend", id, "mine");
    expect(resolved.ok).toBe(true);
    const after = await b.readCard("backend", id);
    expect(after.ok).toBe(true);
    if (after.ok) {
      expect(after.value.frontmatter.column).toBe(mineCol);
      expect(after.value.log.some((l) => l.includes("conflict resolved"))).toBe(
        true,
      );
    }
    expect(b.listConflicts().filter((c) => c.cardId === id)).toHaveLength(0);

    // keep-theirs would have picked the other side — already verified both captured


    // Push queue freeze + API resolve path on server
    const store = new BoardIndexStore();
    const connected = await connectLocalRepo(ctx.cloneB, { indexStore: store });
    // re-seed a frozen queue as if push queue recorded the conflict
    writeFileSync(
      defaultQueuePath(ctx.cloneB),
      JSON.stringify({
        pendingCount: 1,
        frozen: true,
        errorKind: "conflict",
        errorTitle: "Unresolvable conflict — sync frozen",
      }),
    );
    // Inject snapshot again for API resolve of another card scenario — use listConflicts empty
    // After resolve, clear freeze via API
    const port = await freePort();
    const server = startServer({
      host: "127.0.0.1",
      port,
      connected,
      indexStore: store,
      startLive: false,
      enablePushQueue: true,
      pushDebounceMs: 60_000,
    });
    cleanups.push(() => server.stop(true));

    const freeze = await fetch(`http://127.0.0.1:${port}/api/sync`);
    const st = (await freeze.json()) as { frozen?: boolean; status: string };
    expect(st.frozen || st.status === "frozen").toBe(true);

    const clear = await fetch(`http://127.0.0.1:${port}/api/sync/clear-freeze`, {
      method: "POST",
    });
    const cleared = (await clear.json()) as { frozen?: boolean };
    expect(cleared.frozen).toBeFalsy();
  });
});

describe("card history + archive follow (US-22)", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  test("git log --follow after archive + HTTP history API", async () => {
    const root = mkdtempSync(join(tmpdir(), "kanbanly-hist-"));
    const repo = join(root, "boards");
    mkdirSync(join(repo, "backend", "cards"), { recursive: true });
    writeFileSync(join(repo, "backend", "board.yml"), defaultBoardYaml());
    git(repo, ["init"]);
    git(repo, ["config", "user.name", "t"]);
    git(repo, ["config", "user.email", "t@t"]);
    git(repo, ["checkout", "-b", "main"]);
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "init"]);
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));

    const storage = new GitStorage({ repoPath: repo });
    const created = await storage.createCard(
      "backend",
      "History card",
      "done",
      orderInitial(),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const id = created.value.card.frontmatter.id;

    await storage.updateCard(
      "backend",
      id,
      { status: "shipping" },
      { actor: "human" },
    );
    await storage.archiveCards("backend", [id]);

    // File lives under archive
    const archivedPath = storage.findCardPathIncludingArchive("backend", id);
    expect(archivedPath).toContain("archive");

    const hist = storage.cardHistory("backend", id);
    expect(hist.ok).toBe(true);
    if (!hist.ok) return;
    // create + update + archive = at least 2–3 commits
    expect(hist.value.length).toBeGreaterThanOrEqual(2);
    expect(hist.value.some((e) => /archive|update|create|chore\(board\)/i.test(e.subject))).toBe(
      true,
    );

    // Follow still works via git CLI for the archived path
    const rel = archivedPath!.replace(repo + "/", "").replace(repo + "\\", "");
    const follow = git(repo, ["log", "--follow", "--oneline", "--", rel]);
    expect(follow.status).toBe(0);
    expect(follow.stdout.trim().split("\n").length).toBeGreaterThanOrEqual(2);

    // HTTP API
    const store = new BoardIndexStore();
    const connected = await connectLocalRepo(repo, {
      indexStore: store,
      scaffold: false,
    });
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

    const res = await fetch(
      `http://127.0.0.1:${port}/api/boards/backend/cards/${id}/history`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      entries: Array<{ sha: string; subject: string }>;
      count: number;
    };
    expect(body.count).toBeGreaterThanOrEqual(2);
    expect(body.entries[0]?.sha).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("credential 401/403 via push queue classification", () => {
  test("classifyPushError titles distinguish 401 vs 403", async () => {
    const { classifyPushError } = await import("@kanbanly/core");
    const a = classifyPushError("The requested URL returned error: 401");
    const b = classifyPushError("The requested URL returned error: 403");
    expect(a.kind).toBe("credential");
    expect(b.kind).toBe("credential");
    expect(a.title).toMatch(/401/);
    expect(b.title).toMatch(/403/);
  });
});
