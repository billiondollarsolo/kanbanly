/**
 * Offline / credential / conflict classification on push queue + API.
 */
import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { GitStorage, defaultBoardYaml, orderInitial } from "@kanbanly/core";
import { PushQueue, defaultQueuePath, labelFor } from "../src/push-queue.ts";
import { connectLocalRepo } from "../src/connect.ts";
import { BoardIndexStore } from "../src/index-store.ts";
import { startServer } from "../src/app.ts";
import { freePort } from "./helpers.ts";

function git(cwd: string, args: string[]) {
  return spawnSync("git", args, { cwd, encoding: "utf8" });
}

describe("labelFor error statuses", () => {
  test("offline and frozen labels", () => {
    expect(labelFor("offline", 2)).toMatch(/offline.*2/);
    expect(labelFor("frozen", 0)).toMatch(/frozen/i);
  });
});

describe("PushQueue error classification", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  test("unreachable origin classifies as offline and keeps pending", async () => {
    const root = mkdtempSync(join(tmpdir(), "pq-off-"));
    cleanups.push(() => {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    });
    const repo = join(root, "repo");
    mkdirSync(join(repo, "backend", "cards"), { recursive: true });
    writeFileSync(join(repo, "backend", "board.yml"), defaultBoardYaml());
    git(repo, ["init"]);
    git(repo, ["config", "user.name", "t"]);
    git(repo, ["config", "user.email", "t@t"]);
    git(repo, ["checkout", "-b", "main"]);
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "init"]);
    // Dead remote
    git(repo, [
      "remote",
      "add",
      "origin",
      "https://invalid.invalid.example/nope.git",
    ]);

    const storage = new GitStorage({
      repoPath: repo,
      remoteUrl: "https://invalid.invalid.example/nope.git",
      maxPushRetries: 0,
    });
    const q = new PushQueue({
      storage,
      queuePath: defaultQueuePath(repo),
      debounceMs: 60_000,
    });
    cleanups.push(() => q.stop());

    await storage.createCard("backend", "X", "backlog", orderInitial());
    q.enqueue();
    const st = await q.flush();
    expect(st.pendingCount).toBeGreaterThanOrEqual(1);
    // Network failures often look like offline or unknown depending on git message
    expect(
      st.status === "offline" ||
        st.status === "error" ||
        st.errorKind === "offline" ||
        st.errorKind === "unknown" ||
        st.errorKind === "credential",
    ).toBe(true);
    expect(st.label.length).toBeGreaterThan(0);
  });

  test("clearFreeze unblocks scheduling after conflict freeze", async () => {
    const root = mkdtempSync(join(tmpdir(), "pq-frz-"));
    cleanups.push(() => {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    });
    const repo = join(root, "repo");
    mkdirSync(join(repo, "backend", "cards"), { recursive: true });
    writeFileSync(join(repo, "backend", "board.yml"), defaultBoardYaml());
    git(repo, ["init"]);
    git(repo, ["config", "user.name", "t"]);
    git(repo, ["config", "user.email", "t@t"]);
    git(repo, ["checkout", "-b", "main"]);
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "init"]);

    const storage = new GitStorage({ repoPath: repo });
    const qPath = defaultQueuePath(repo);
    // Seed a frozen queue.json as if a conflict was recorded
    mkdirSync(join(repo, ".kanbanly"), { recursive: true });
    writeFileSync(
      qPath,
      JSON.stringify({
        pendingCount: 2,
        lastError: "CONFLICT: cards/c-1.md",
        errorKind: "conflict",
        errorTitle: "Unresolvable conflict — sync frozen",
        errorDetail: "Diverged: cards/c-1.md",
        frozen: true,
      }),
    );

    const q = new PushQueue({ storage, queuePath: qPath, debounceMs: 60_000 });
    cleanups.push(() => q.stop());
    expect(q.getState().frozen).toBe(true);
    expect(q.getState().status).toBe("frozen");
    expect(q.getState().label).toMatch(/frozen/i);

    q.clearFreeze();
    expect(q.getState().frozen).toBe(false);
    expect(q.getState().pendingCount).toBe(2);
    // No origin → no_remote (not a stuck pending push); with origin would be pending.
    expect(["pending", "no_remote"]).toContain(q.getState().status);

    // Persist
    const disk = JSON.parse(readFileSync(qPath, "utf8")) as { frozen?: boolean };
    expect(disk.frozen).toBe(false);
  });

  test("HTTP clear-freeze + sync exposes error fields", async () => {
    const root = mkdtempSync(join(tmpdir(), "pq-http-"));
    cleanups.push(() => {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    });
    const repo = join(root, "repo");
    mkdirSync(join(repo, "backend", "cards"), { recursive: true });
    writeFileSync(join(repo, "backend", "board.yml"), defaultBoardYaml());
    git(repo, ["init"]);
    git(repo, ["config", "user.name", "t"]);
    git(repo, ["config", "user.email", "t@t"]);
    git(repo, ["checkout", "-b", "main"]);
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "init"]);
    mkdirSync(join(repo, ".kanbanly"), { recursive: true });
    writeFileSync(
      defaultQueuePath(repo),
      JSON.stringify({
        pendingCount: 1,
        frozen: true,
        errorKind: "conflict",
        errorTitle: "Unresolvable conflict — sync frozen",
        errorDetail: "cards/x.md",
        lastError: "conflict",
      }),
    );

    const store = new BoardIndexStore();
    const connected = await connectLocalRepo(repo, { indexStore: store });
    const port = await freePort();
    const server = startServer({
      host: "127.0.0.1",
      port,
      connected,
      indexStore: store,
      startLive: false,
    });
    cleanups.push(() => server.stop(true));

    const sync = await fetch(`http://127.0.0.1:${port}/api/sync`);
    const st = (await sync.json()) as {
      status: string;
      frozen?: boolean;
      errorKind?: string;
      errorTitle?: string;
    };
    expect(st.frozen).toBe(true);
    expect(st.errorKind).toBe("conflict");
    expect(st.errorTitle).toMatch(/conflict/i);

    const unfreeze = await fetch(
      `http://127.0.0.1:${port}/api/sync/clear-freeze`,
      { method: "POST" },
    );
    const after = (await unfreeze.json()) as { frozen?: boolean; status: string };
    expect(after.frozen).toBe(false);
  });
});
