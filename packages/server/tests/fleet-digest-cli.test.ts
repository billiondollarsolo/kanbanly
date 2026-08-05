import { describe, expect, test, afterEach } from "bun:test";
import { main as cliMain, parseArgs } from "../src/cli.ts";
import { freePort, makeTempRepoFromFixture } from "./helpers.ts";
import { connectLocalRepo } from "../src/connect.ts";
import { BoardIndexStore } from "../src/index-store.ts";
import { startServer } from "../src/app.ts";

describe("fleet-digest CLI + API text", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  test("parseArgs fleet-digest flags", () => {
    const o = parseArgs([
      "fleet-digest",
      "--repo",
      "/tmp/boards",
      "--json",
      "--fail-on-high",
      "--only-issues",
      "--webhook",
      "https://hooks.example/x",
    ]);
    expect(o.command).toBe("fleet-digest");
    expect(o.repo).toBe("/tmp/boards");
    expect(o.json).toBe(true);
    expect(o.failOnHigh).toBe(true);
    expect(o.onlyIssues).toBe(true);
    expect(o.webhook).toBe("https://hooks.example/x");
  });

  test("CLI prints digest for fixture boards", async () => {
    const ctx = makeTempRepoFromFixture();
    cleanups.push(ctx.cleanup);

    const logs: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
    try {
      await cliMain(["fleet-digest", "--repo", ctx.repoPath]);
    } finally {
      console.log = orig;
    }
    const out = logs.join("\n");
    expect(out).toContain("kanbanly fleet");
    expect(out).toMatch(/OK|NEEDS ATTENTION/);
    expect(out).toMatch(/boards \d+/);
  });

  test("GET /api/fleet-health?format=text returns plain digest", async () => {
    const ctx = makeTempRepoFromFixture();
    cleanups.push(ctx.cleanup);
    const store = new BoardIndexStore();
    const connected = await connectLocalRepo(ctx.repoPath, { indexStore: store });
    const port = await freePort();
    const server = startServer({
      host: "127.0.0.1",
      port,
      connected,
      indexStore: store,
      enablePushQueue: false,
      startLive: false,
    });
    cleanups.push(() => server.stop(true));

    const res = await fetch(
      `http://127.0.0.1:${port}/api/fleet-health?format=text`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/plain");
    const body = await res.text();
    expect(body).toContain("kanbanly fleet");
    expect(body).toMatch(/boards \d+/);
  });
});
