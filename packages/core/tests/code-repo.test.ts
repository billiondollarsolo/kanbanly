import { describe, expect, test, afterEach } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  defaultCodeCloneRoot,
  ensureCodeRepo,
  listCodeCommits,
  slugFromCodeRemote,
} from "../src/code-repo.ts";
import {
  getNotesTool,
  listProjectCommitsTool,
  setCodeBindingTool,
  updateNotesTool,
  ALL_AI_TOOLS,
} from "../src/ai-tools.ts";

function git(cwd: string, args: string[]) {
  return spawnSync("git", args, { cwd, encoding: "utf8" });
}

function makeBareProduct(): { bare: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "kanbanly-code-bare-"));
  const bare = join(root, "app.git");
  const seed = join(root, "seed");
  mkdirSync(bare, { recursive: true });
  git(bare, ["init", "--bare"]);
  git(root, ["clone", bare, seed]);
  git(seed, ["config", "user.name", "dev"]);
  git(seed, ["config", "user.email", "d@d"]);
  writeFileSync(join(seed, "app.ts"), "export const n = 1;\n");
  git(seed, ["add", "."]);
  git(seed, ["commit", "-m", "feat: product bootstrap"]);
  git(seed, ["branch", "-M", "main"]);
  git(seed, ["push", "-u", "origin", "main"]);
  return {
    bare,
    cleanup: () => {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    },
  };
}

describe("code-repo ensure + tools", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  test("slugFromCodeRemote is stable-ish", () => {
    expect(slugFromCodeRemote("https://github.com/you/my-app.git")).toMatch(
      /my-app/,
    );
  });

  test("ensureCodeRepo clones remote into code-clones under home", () => {
    const pair = makeBareProduct();
    cleanups.push(pair.cleanup);
    const home = mkdtempSync(join(tmpdir(), "kanbanly-home-"));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));

    const first = ensureCodeRepo({
      remote: pair.bare,
      home,
      fetch: false,
    });
    expect(first.cloned).toBe(true);
    expect(existsSync(join(first.path, ".git"))).toBe(true);
    expect(first.path.startsWith(defaultCodeCloneRoot(home))).toBe(true);

    const commits = listCodeCommits(first.path, { limit: 10 });
    expect(commits.some((c) => c.subject.includes("product bootstrap"))).toBe(
      true,
    );

    const second = ensureCodeRepo({
      remote: pair.bare,
      home,
      fetch: false,
    });
    expect(second.cloned).toBe(false);
    expect(second.path).toBe(first.path);
  });

  test("ensureCodeRepo accepts local path", () => {
    const root = mkdtempSync(join(tmpdir(), "kanbanly-local-code-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    git(root, ["init"]);
    git(root, ["config", "user.name", "t"]);
    git(root, ["config", "user.email", "t@t"]);
    writeFileSync(join(root, "x.md"), "hi\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "feat: local only"]);

    const r = ensureCodeRepo({ path: root });
    expect(r.cloned).toBe(false);
    expect(r.path).toBe(root);
    expect(listCodeCommits(r.path)[0]!.subject).toContain("local only");
  });

  test("AI tools include notes + project commits + code binding", () => {
    const names = ALL_AI_TOOLS.map((t) => t.name);
    expect(names).toContain("get_notes");
    expect(names).toContain("list_project_commits");
    expect(names).toContain("set_code_binding");
    expect(names).toContain("update_notes");
    expect(getNotesTool.kind).toBe("read");
    expect(listProjectCommitsTool.kind).toBe("read");
    expect(setCodeBindingTool.requiresConfirm).toBe(true);
    expect(updateNotesTool.requiresConfirm).toBe(true);
  });
});
