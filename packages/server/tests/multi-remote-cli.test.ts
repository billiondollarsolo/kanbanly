import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { BoardIndexStore } from "../src/index-store.ts";
import { startServer } from "../src/app.ts";
import { parseArgs, main as cliMain } from "../src/cli.ts";
import { RemoteRegistry, slugifyRemoteKey } from "../src/remote-registry.ts";
import { freePort, makeTempRepoFromFixture } from "./helpers.ts";
import { connectLocalRepo } from "../src/connect.ts";

describe("RemoteRegistry", () => {
  test("slugify + unique slugs on collision", async () => {
    expect(slugifyRemoteKey("/tmp/foo/my-boards")).toBe("my-boards");
    const a = makeTempRepoFromFixture();
    const b = makeTempRepoFromFixture();
    try {
      const store = new BoardIndexStore();
      const ca = await connectLocalRepo(a.repoPath, { indexStore: store });
      const cb = await connectLocalRepo(b.repoPath, { indexStore: store });
      const reg = new RemoteRegistry();
      const ea = reg.add(ca, "boards");
      const eb = reg.add(cb, "boards");
      expect(ea.slug).toBe("boards");
      expect(eb.slug).toBe("boards-2");
      expect(reg.active()?.slug).toBe("boards-2");
      expect(reg.setActive("boards")).toBe(true);
      expect(reg.active()?.slug).toBe("boards");
      expect(reg.summaries()).toHaveLength(2);
    } finally {
      a.cleanup();
      b.cleanup();
    }
  });
});

describe("multi-remote HTTP API", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  test("connect two remotes; switch active; list sidebar data", async () => {
    const a = makeTempRepoFromFixture();
    const b = makeTempRepoFromFixture();
    cleanups.push(a.cleanup, b.cleanup);
    const store = new BoardIndexStore();
    const port = await freePort();
    const server = startServer({
      host: "127.0.0.1",
      port,
      indexStore: store,
      startLive: false,
      enablePushQueue: false,
    });
    cleanups.push(() => server.stop(true));

    const c1 = await fetch(`http://127.0.0.1:${port}/api/connect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: a.repoPath }),
    });
    expect(c1.status).toBe(200);
    const b1 = (await c1.json()) as { slug: string; remotes: unknown[] };
    expect(b1.slug).toBeTruthy();
    expect(b1.remotes.length).toBe(1);

    const c2 = await fetch(`http://127.0.0.1:${port}/api/connect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: b.repoPath }),
    });
    const b2 = (await c2.json()) as { slug: string; remotes: Array<{ slug: string }> };
    expect(b2.remotes.length).toBe(2);

    const listed = await fetch(`http://127.0.0.1:${port}/api/remotes`);
    const body = (await listed.json()) as {
      remotes: Array<{ slug: string; active: boolean }>;
      active: string;
    };
    expect(body.remotes.length).toBe(2);
    expect(body.active).toBe(b2.slug);

    // Switch back to first
    const sw = await fetch(`http://127.0.0.1:${port}/api/remotes/active`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug: b1.slug }),
    });
    expect(sw.status).toBe(200);
    const swBody = (await sw.json()) as { active: string };
    expect(swBody.active).toBe(b1.slug);

    const boards = await fetch(`http://127.0.0.1:${port}/api/boards`);
    const bl = (await boards.json()) as { boards: Array<{ id: string }> };
    expect(bl.boards.map((x) => x.id).sort()).toEqual(["backend", "web"]);
  });
});

describe("CLI setup + skill-install", () => {
  test("parseArgs accepts setup flags", () => {
    const o = parseArgs([
      "setup",
      "--code",
      "/code",
      "--boards",
      "/boards",
      "--remote",
      "git@x/y.git",
      "--board",
      "api",
    ]);
    expect(o.command).toBe("setup");
    expect(o.code).toBe("/code");
    expect(o.boards).toBe("/boards");
    expect(o.remote).toBe("git@x/y.git");
    expect(o.board).toBe("api");
  });

  test("setup writes kanbanly.yml and board scaffold", async () => {
    const root = mkdtempSync(join(tmpdir(), "kanbanly-cli-setup-"));
    const code = join(root, "code");
    const boards = join(root, "boards");
    mkdirSync(code, { recursive: true });
    mkdirSync(boards, { recursive: true });
    spawnSync("git", ["init"], { cwd: boards });

    // Run setup via imported kanbanlySetup path through CLI main
    await cliMain([
      "setup",
      "--code",
      code,
      "--boards",
      boards,
      "--remote",
      "https://example.com/boards.git",
      "--board",
      "backend",
    ]);

    expect(existsSync(join(code, ".kanbanly.yml"))).toBe(true);
    const yml = readFileSync(join(code, ".kanbanly.yml"), "utf8");
    expect(yml).toContain("remote: https://example.com/boards.git");
    expect(existsSync(join(boards, "backend", "board.yml"))).toBe(true);
    expect(existsSync(join(boards, ".gitattributes"))).toBe(true);
  });

  test("skill-install --path writes SKILL.md", async () => {
    const root = mkdtempSync(join(tmpdir(), "kanbanly-skill-"));
    await cliMain(["skill-install", "--path", root]);
    expect(existsSync(join(root, "kanbanly", "SKILL.md"))).toBe(true);
  });
});
