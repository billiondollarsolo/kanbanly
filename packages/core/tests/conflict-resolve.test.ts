import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serializeCard, type Card } from "../src/card.ts";
import {
  resolveConflictText,
  resolveConflictSides,
  hasConflictMarkers,
} from "../src/heal.ts";
import { GitStorage } from "../src/storage/git.ts";
import { CredentialStore, gitAuthEnv } from "../src/storage/credentials.ts";

function makeCard(
  id: string,
  column: string,
  updated: string,
  status: string,
  title = "Conflict card",
): Card {
  return {
    frontmatter: {
      id,
      title,
      column,
      order: "m",
      updated,
      labels: [],
    },
    status,
    log: [`2026-08-01 human: created`],
  };
}

describe("resolveConflictText / sides", () => {
  test("keep mine and keep theirs from markers", () => {
    const ours = serializeCard(
      makeCard("c-cf01", "doing", "2026-08-04T10:00:00Z", "ours status"),
    );
    const theirs = serializeCard(
      makeCard("c-cf01", "review", "2026-08-04T12:00:00Z", "theirs status"),
    );
    const conflicted = `<<<<<<< HEAD\n${ours}=======\n${theirs}>>>>>>> branch\n`;
    const mine = resolveConflictText(conflicted, "mine");
    const their = resolveConflictText(conflicted, "theirs");
    expect(hasConflictMarkers(mine)).toBe(false);
    expect(mine).toContain("column: doing");
    expect(mine).toContain("ours status");
    expect(their).toContain("column: review");
    expect(their).toContain("theirs status");
  });

  test("resolveConflictSides heal merges", () => {
    const ours = serializeCard(
      makeCard("c-cf02", "doing", "2026-08-04T10:00:00Z", "a"),
    );
    const theirs = serializeCard(
      makeCard("c-cf02", "review", "2026-08-04T12:00:00Z", "b"),
    );
    const healed = resolveConflictSides(ours, theirs, "heal");
    expect(hasConflictMarkers(healed)).toBe(false);
    expect(healed).toContain("column: review");
  });
});

describe("GitStorage.resolveConflict", () => {
  test("keep-mine from stored snapshot commits clean card", async () => {
    const root = mkdtempSync(join(tmpdir(), "kanbanly-cfl-"));
    const repo = join(root, "repo");
    mkdirSync(join(repo, "backend", "cards"), { recursive: true });
    writeFileSync(
      join(repo, "backend", "board.yml"),
      `columns:\n  - id: backlog\n    name: Backlog\n  - id: doing\n    name: Doing\n  - id: review\n    name: Review\n`,
    );

    const storage = GitStorage.initLocal(repo);
    const ours = serializeCard(
      makeCard("c-cfl1", "doing", "2026-08-04T10:00:00Z", "mine body", "Mine"),
    );
    const theirs = serializeCard(
      makeCard("c-cfl1", "review", "2026-08-04T12:00:00Z", "theirs body", "Mine"),
    );

    // Seed base card so write path has a file
    writeFileSync(join(repo, "backend", "cards", "c-cfl1-mine.md"), ours);
    storage.git(["add", "."]);
    storage.git(["commit", "-m", "base"]);

    // Inject conflict snapshot as push would
    const path = "backend/cards/c-cfl1-mine.md";
    mkdirSync(join(repo, ".kanbanly"), { recursive: true });
    writeFileSync(
      join(repo, ".kanbanly", "conflicts.json"),
      JSON.stringify({
        createdAt: new Date().toISOString(),
        files: [
          {
            path,
            boardId: "backend",
            cardId: "c-cfl1",
            title: "Mine",
            ours,
            theirs,
          },
        ],
      }),
    );

    expect(storage.listConflicts()).toHaveLength(1);

    const r = await storage.resolveConflict("backend", "c-cfl1", "mine");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.choice).toBe("mine");
    expect(storage.listConflicts()).toHaveLength(0);

    const text = readFileSync(
      join(repo, "backend", "cards", "c-cfl1-mine.md"),
      "utf8",
    );
    expect(text).toContain("column: doing");
    expect(text).toContain("mine body");
    expect(text).toContain("conflict resolved (mine)");
    expect(hasConflictMarkers(text)).toBe(false);
  });

  test("keep-theirs selects incoming side", async () => {
    const root = mkdtempSync(join(tmpdir(), "kanbanly-cfl2-"));
    const repo = join(root, "repo");
    mkdirSync(join(repo, "backend", "cards"), { recursive: true });
    writeFileSync(
      join(repo, "backend", "board.yml"),
      `columns:\n  - id: backlog\n    name: Backlog\n  - id: review\n    name: Review\n`,
    );
    const storage = GitStorage.initLocal(repo);
    const ours = serializeCard(
      makeCard("c-cfl2", "doing", "2026-08-04T10:00:00Z", "a", "T"),
    );
    const theirs = serializeCard(
      makeCard("c-cfl2", "review", "2026-08-04T12:00:00Z", "b", "T"),
    );
    writeFileSync(join(repo, "backend", "cards", "c-cfl2-t.md"), ours);
    storage.git(["add", "."]);
    storage.git(["commit", "-m", "base"]);
    mkdirSync(join(repo, ".kanbanly"), { recursive: true });
    writeFileSync(
      join(repo, ".kanbanly", "conflicts.json"),
      JSON.stringify({
        createdAt: new Date().toISOString(),
        files: [
          {
            path: "backend/cards/c-cfl2-t.md",
            boardId: "backend",
            cardId: "c-cfl2",
            title: "T",
            ours,
            theirs,
          },
        ],
      }),
    );

    const r = await storage.resolveConflict("backend", "c-cfl2", "theirs");
    expect(r.ok).toBe(true);
    const text = readFileSync(
      join(repo, "backend", "cards", "c-cfl2-t.md"),
      "utf8",
    );
    expect(text).toContain("column: review");
    expect(text).toContain("conflict resolved (theirs)");
  });
});

describe("CredentialStore", () => {
  test("set / get / status / clear never exposes token in status", () => {
    const root = mkdtempSync(join(tmpdir(), "kanbanly-cred-"));
    const store = new CredentialStore(join(root, "credentials.json"));
    expect(store.has()).toBe(false);
    store.set({ token: "ghp_test_secret_token", username: "x-access-token" });
    expect(store.has()).toBe(true);
    expect(store.get()?.token).toBe("ghp_test_secret_token");
    const st = store.status();
    expect(st.configured).toBe(true);
    expect(st.username).toBe("x-access-token");
    expect(JSON.stringify(st)).not.toContain("ghp_test_secret_token");
    const env = gitAuthEnv(store.get()!, root);
    expect(env?.GIT_ASKPASS).toBeTruthy();
    store.clear();
    expect(store.has()).toBe(false);
  });
});
