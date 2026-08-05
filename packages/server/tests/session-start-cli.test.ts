import { describe, expect, test, afterEach } from "bun:test";
import { main as cliMain } from "../src/cli.ts";
import { makeTempRepoFromFixture } from "./helpers.ts";

describe("session-start CLI", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  test("prints brief with board id and ready/doing sections", async () => {
    const ctx = makeTempRepoFromFixture();
    cleanups.push(ctx.cleanup);

    const logs: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
    try {
      await cliMain([
        "session-start",
        "--repo",
        ctx.repoPath,
        "--board",
        "backend",
        "--agent",
        "claude",
      ]);
    } finally {
      console.log = orig;
    }
    const out = logs.join("\n");
    expect(out).toContain("Session start");
    expect(out).toContain("backend");
    expect(out).toMatch(/Ready|Doing|Pickup/i);
  });
});
