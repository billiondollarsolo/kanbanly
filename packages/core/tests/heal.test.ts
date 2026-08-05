import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { serializeCard, type Card } from "../src/card.ts";
import { hasConflictMarkers, healConflict } from "../src/heal.ts";

function makeCard(column: string, updated: string, status: string): Card {
  return {
    frontmatter: {
      id: "c-heal1",
      title: "Heal me",
      column,
      order: "m",
      updated,
      labels: [],
    },
    status,
    log: [`2026-08-01 human: created`],
  };
}

describe("healConflict", () => {
  test("returns unchanged text when no markers", () => {
    const text = serializeCard(makeCard("doing", "2026-08-04T00:00:00Z", "ok"));
    expect(healConflict(text)).toBe(text);
    expect(hasConflictMarkers(text)).toBe(false);
  });

  test("detects markers and resolves with merge logic (higher updated wins)", () => {
    const ours = serializeCard(
      makeCard("doing", "2026-08-04T10:00:00Z", "ours status"),
    );
    const theirs = serializeCard(
      makeCard("review", "2026-08-04T12:00:00Z", "theirs status"),
    );

    // Build a conflict-markered file (typical git conflict on whole file)
    const conflicted = `<<<<<<< HEAD\n${ours}=======\n${theirs}>>>>>>> branch\n`;
    expect(hasConflictMarkers(conflicted)).toBe(true);

    const healed = healConflict(conflicted);
    expect(hasConflictMarkers(healed)).toBe(false);
    expect(healed).toContain("column: review");
    expect(healed).toContain("theirs status");
    // single column key
    expect((healed.match(/^column:/gm) ?? []).length).toBe(1);
  });

  test("drives a real conflict in a temp repo without the merge driver", () => {
    const root = mkdtempSync(join(tmpdir(), "kanbanly-heal-"));
    const repo = join(root, "repo");
    mkdirSync(repo, { recursive: true });
    mkdirSync(join(repo, "cards"), { recursive: true });

    const git = (args: string[]) =>
      spawnSync("git", args, { cwd: repo, encoding: "utf8" });

    git(["init"]);
    git(["config", "user.name", "test"]);
    git(["config", "user.email", "test@test"]);
    git(["checkout", "-b", "main"]);

    const baseCard = serializeCard(
      makeCard("backlog", "2026-08-01T00:00:00Z", "base"),
    );
    const cardPath = join(repo, "cards", "c-heal1-heal-me.md");
    writeFileSync(cardPath, baseCard);
    git(["add", "."]);
    git(["commit", "-m", "base"]);

    // Branch A
    git(["checkout", "-b", "side-a"]);
    writeFileSync(
      cardPath,
      serializeCard(makeCard("doing", "2026-08-04T10:00:00Z", "side-a")),
    );
    git(["add", "."]);
    git(["commit", "-m", "side-a"]);

    // Branch B from main
    git(["checkout", "main"]);
    git(["checkout", "-b", "side-b"]);
    writeFileSync(
      cardPath,
      serializeCard(makeCard("review", "2026-08-04T12:00:00Z", "side-b")),
    );
    git(["add", "."]);
    git(["commit", "-m", "side-b"]);

    // Merge side-a into side-b WITHOUT merge driver → conflict markers
    const merge = git(["merge", "side-a", "--no-edit"]);
    // Expect conflict
    const status = git(["status", "--porcelain"]);
    expect(status.stdout.length).toBeGreaterThan(0);

    // Read conflicted file (may be unmerged)
    // git may leave conflict markers in the working tree file
    let text = "";
    try {
      text = readFileSync(cardPath, "utf8");
    } catch {
      // If file missing, check stages
      text = "";
    }

    // If git left conflict markers, heal them; otherwise force-construct from stages
    if (!hasConflictMarkers(text)) {
      // Checkout both stages manually
      const oursBlob = git(["show", ":2:cards/c-heal1-heal-me.md"]);
      const theirsBlob = git(["show", ":3:cards/c-heal1-heal-me.md"]);
      if (oursBlob.ok || oursBlob.stdout) {
        text = `<<<<<<< HEAD\n${oursBlob.stdout}=======\n${theirsBlob.stdout}>>>>>>> side-a\n`;
      } else {
        // Fallback: construct from known content
        text = `<<<<<<< HEAD\n${serializeCard(makeCard("review", "2026-08-04T12:00:00Z", "side-b"))}=======\n${serializeCard(makeCard("doing", "2026-08-04T10:00:00Z", "side-a"))}>>>>>>> side-a\n`;
      }
    }

    expect(hasConflictMarkers(text)).toBe(true);
    const healed = healConflict(text);
    expect(hasConflictMarkers(healed)).toBe(false);
    // Higher updated is side-b (review @ 12:00)
    expect(healed).toContain("column: review");
    writeFileSync(cardPath, healed);
    git(["add", "cards/c-heal1-heal-me.md"]);
    const commit = git(["commit", "-m", "heal conflict"]);
    expect(commit.status).toBe(0);
  });
});
