import { describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  CredentialStore,
  encryptToken,
  decryptToken,
  isEncryptedToken,
  globalCredentialPath,
  globalCredentialKeyPath,
  globalKanbanlyDir,
  GitStorage,
  healConflict,
  hasConflictMarkers,
  serializeCard,
  runMergeDriverSync,
  type Card,
} from "../src/index.ts";
import { orderInitial } from "../src/order.ts";
import { defaultBoardYaml } from "../src/board.ts";

describe("encrypted credentials (NFR-6)", () => {
  test("encrypt/decrypt round-trip", () => {
    const key = Buffer.alloc(32, 7);
    const enc = encryptToken("ghp_secret_token_value", key);
    expect(isEncryptedToken(enc)).toBe(true);
    expect(enc).not.toContain("ghp_secret");
    expect(decryptToken(enc, key)).toBe("ghp_secret_token_value");
  });

  test("CredentialStore writes encrypted token and 0600 file", () => {
    const root = mkdtempSync(join(tmpdir(), "kanbanly-enc-"));
    const path = join(root, ".kanbanly", "credentials.json");
    const store = new CredentialStore(path, {
      env: { KANBANLY_CREDENTIAL_KEY: "test-master-key-for-unit" },
    });
    store.set({ token: "ghp_plain_secret", username: "x-access-token" });
    const raw = JSON.parse(readFileSync(path, "utf8")) as {
      token: string;
      encrypted?: boolean;
    };
    expect(raw.encrypted).toBe(true);
    expect(isEncryptedToken(raw.token)).toBe(true);
    expect(JSON.stringify(raw)).not.toContain("ghp_plain_secret");
    expect(store.get()?.token).toBe("ghp_plain_secret");
    expect(store.status().encrypted).toBe(true);
    // mode 0600 when platform supports it
    if (process.platform !== "win32") {
      const mode = statSync(path).mode & 0o777;
      expect(mode & 0o044).toBe(0);
    }
  });

  test("global ~/.kanbanly/key path helpers", () => {
    const home = mkdtempSync(join(tmpdir(), "kanbanly-home-"));
    expect(globalKanbanlyDir(home)).toContain(".kanbanly");
    expect(globalCredentialPath(home)).toEndWith("credentials.json");
    expect(globalCredentialKeyPath(home)).toEndWith("key");
    const store = CredentialStore.global({
      home,
      env: { KANBANLY_CREDENTIAL_KEY: "global-test-key" },
    });
    store.set({ token: "ghp_global_secret" });
    expect(store.get()?.token).toBe("ghp_global_secret");
    const raw = JSON.parse(readFileSync(globalCredentialPath(home), "utf8")) as {
      token: string;
    };
    expect(raw.token.startsWith("enc:v1:")).toBe(true);
  });

  test("legacy plaintext still readable then re-encrypts on set", () => {
    const root = mkdtempSync(join(tmpdir(), "kanbanly-legacy-"));
    mkdirSync(join(root, ".kanbanly"), { recursive: true });
    const path = join(root, ".kanbanly", "credentials.json");
    writeFileSync(
      path,
      JSON.stringify({
        username: "git",
        token: "legacy-plain",
        updatedAt: new Date().toISOString(),
      }),
      { mode: 0o600 },
    );
    const store = new CredentialStore(path, {
      env: { KANBANLY_CREDENTIAL_KEY: "k2" },
    });
    // get() decrypts identity for legacy
    expect(store.get()?.token).toBe("legacy-plain");
    store.set({ token: "legacy-plain", username: "git" });
    const raw = JSON.parse(readFileSync(path, "utf8")) as { token: string };
    expect(isEncryptedToken(raw.token)).toBe(true);
  });
});

describe("healWorkingTree on fetch path (FR-7)", () => {
  test("heals conflict-markered card and commits", async () => {
    const root = mkdtempSync(join(tmpdir(), "kanbanly-healwt-"));
    const repo = join(root, "boards");
    mkdirSync(join(repo, "backend", "cards"), { recursive: true });
    writeFileSync(join(repo, "backend", "board.yml"), defaultBoardYaml());
    spawnSync("git", ["init"], { cwd: repo });
    spawnSync("git", ["config", "user.name", "t"], { cwd: repo });
    spawnSync("git", ["config", "user.email", "t@t"], { cwd: repo });
    spawnSync("git", ["checkout", "-b", "main"], { cwd: repo });

    const card: Card = {
      frontmatter: {
        id: "c-heal9",
        title: "Heal WT",
        column: "doing",
        order: orderInitial(),
        updated: "2026-08-04T10:00:00Z",
        labels: [],
      },
      status: "ours",
      log: ["2026-08-01 human: created"],
    };
    const theirs: Card = {
      ...card,
      frontmatter: {
        ...card.frontmatter,
        column: "review",
        updated: "2026-08-04T12:00:00Z",
      },
      status: "theirs",
    };
    const conflicted = `<<<<<<< HEAD\n${serializeCard(card)}=======\n${serializeCard(theirs)}>>>>>>> branch\n`;
    writeFileSync(join(repo, "backend", "cards", "c-heal9-heal-wt.md"), conflicted);
    spawnSync("git", ["add", "."], { cwd: repo });
    spawnSync("git", ["commit", "-m", "seed conflicted"], { cwd: repo });

    const storage = new GitStorage({ repoPath: repo });
    const r = await storage.healWorkingTree();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.healed.length).toBe(1);
    const text = readFileSync(
      join(repo, "backend", "cards", "c-heal9-heal-wt.md"),
      "utf8",
    );
    expect(hasConflictMarkers(text)).toBe(false);
    expect(text).toContain("column: review"); // higher updated wins
    expect(healConflict(conflicted)).not.toContain("<<<<<<<");
  });
});

describe("Node-compatible merge driver (NFR-9)", () => {
  test("runMergeDriverSync uses node:fs only", () => {
    const root = mkdtempSync(join(tmpdir(), "kanbanly-mdsync-"));
    const card = (col: string, updated: string, status: string): Card => ({
      frontmatter: {
        id: "c-nd01",
        title: "Node merge",
        column: col,
        order: "m",
        updated,
        labels: [],
      },
      status,
      log: ["2026-08-01 human: created"],
    });
    const pO = join(root, "O.md");
    const pA = join(root, "A.md");
    const pB = join(root, "B.md");
    writeFileSync(pO, serializeCard(card("backlog", "2026-08-01T00:00:00Z", "base")));
    writeFileSync(pA, serializeCard(card("doing", "2026-08-04T10:00:00Z", "ours")));
    writeFileSync(pB, serializeCard(card("review", "2026-08-04T12:00:00Z", "theirs")));
    runMergeDriverSync(pO, pA, pB);
    const out = readFileSync(pA, "utf8");
    expect(out).toContain("column: review");
    expect(out).toContain("theirs");
  });
});
