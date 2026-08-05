import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { kanbanlySetup, skillInstall } from "../src/setup.ts";

describe("kanbanlySetup", () => {
  test("writes .kanbanly.yml, pointers, gitattributes, board scaffold, merge driver config", () => {
    const root = mkdtempSync(join(tmpdir(), "kanbanly-setup-"));
    const code = join(root, "code");
    const boards = join(root, "boards");
    mkdirSync(code, { recursive: true });
    mkdirSync(boards, { recursive: true });
    spawnSync("git", ["init"], { cwd: boards });
    spawnSync("git", ["config", "user.name", "t"], { cwd: boards });
    spawnSync("git", ["config", "user.email", "t@t"], { cwd: boards });

    const result = kanbanlySetup({
      codeRepoPath: code,
      boardsRepoPath: boards,
      remote: "git@github.com:mj/kanbanly-boards.git",
      board: "backend",
      mergeDriverCommand: "kanbanly merge-driver %O %A %B %L %P",
    });

    const yml = readFileSync(join(code, ".kanbanly.yml"), "utf8");
    expect(yml).toContain("remote: git@github.com:mj/kanbanly-boards.git");
    expect(yml).toContain("board:");
    expect(yml).toContain("backend");

    const agents = readFileSync(join(code, "AGENTS.md"), "utf8");
    expect(agents).toContain("kanbanly");
    const claude = readFileSync(join(code, "CLAUDE.md"), "utf8");
    expect(claude).toContain("kanbanly");

    // Idempotent append
    kanbanlySetup({
      codeRepoPath: code,
      boardsRepoPath: boards,
      remote: "git@github.com:mj/kanbanly-boards.git",
      board: "backend",
    });
    const agents2 = readFileSync(join(code, "AGENTS.md"), "utf8");
    const count = (agents2.match(/<!-- kanbanly -->/g) ?? []).length;
    expect(count).toBe(1);

    const ga = readFileSync(join(boards, ".gitattributes"), "utf8");
    expect(ga).toContain("**/cards/*.md merge=kanbanly");

    expect(existsSync(join(boards, "backend", "board.yml"))).toBe(true);
    expect(existsSync(join(boards, "backend", "cards"))).toBe(true);
    expect(existsSync(join(boards, "AGENTS.md"))).toBe(true);

    const cfg = spawnSync(
      "git",
      ["config", "--get", "merge.kanbanly.driver"],
      { cwd: boards, encoding: "utf8" },
    );
    expect(cfg.stdout.trim()).toContain("kanbanly merge-driver");

    expect(result.kanbanlyYml).toContain("remote:");

    rmSync(root, { recursive: true, force: true });
  });
});

describe("skillInstall", () => {
  test("installs to --path and is idempotent", () => {
    const root = mkdtempSync(join(tmpdir(), "kanbanly-skill-"));
    const r1 = skillInstall({ path: root, skillContent: "# skill v1\n" });
    expect(r1.installed.length).toBe(1);
    expect(existsSync(r1.installed[0]!)).toBe(true);
    expect(readFileSync(r1.installed[0]!, "utf8")).toContain("skill v1");

    const r2 = skillInstall({ path: root, skillContent: "# skill v2\n" });
    expect(readFileSync(r2.installed[0]!, "utf8")).toContain("skill v2");

    rmSync(root, { recursive: true, force: true });
  });
});
