import { describe, expect, test, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { main as cliMain } from "../src/cli.ts";
import { makeTempRepoFromFixture, git } from "./helpers.ts";

describe("session-end CLI", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  test("appends session-end log line via real git write", async () => {
    const ctx = makeTempRepoFromFixture();
    cleanups.push(ctx.cleanup);

    await cliMain([
      "session-end",
      "--repo",
      ctx.repoPath,
      "--board",
      "backend",
      "--card",
      "c-a1b2",
      "--summary",
      "wired middleware tests",
      "--agent",
      "claude",
      "--sha",
      "deadbeef",
      "--status",
      "Tests green.",
    ]);

    const md = readFileSync(
      join(ctx.repoPath, "backend", "cards", "c-a1b2-setup-auth-middleware.md"),
      "utf8",
    );
    expect(md).toContain("session-end");
    expect(md).toContain("wired middleware tests");
    expect(md).toContain("deadbeef");
    expect(md).toContain("Tests green.");
    const log = git(ctx.repoPath, ["log", "-1", "--format=%s"]);
    expect(log.stdout).toMatch(/session-end/);
  });
});
