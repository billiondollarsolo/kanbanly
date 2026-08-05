import { describe, expect, test, afterEach } from "bun:test";
import {
  parseArgs,
  warnIfPublicBind,
  isLoopbackHost,
  DEFAULT_HOST,
  DEFAULT_PORT,
  LOOPBACK_HOSTS,
} from "../src/cli.ts";
import { startServer } from "../src/app.ts";
import { freePort } from "./helpers.ts";

describe("CLI default bind + non-loopback warning (shipped cli.ts)", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  test("parseArgs defaults host to 127.0.0.1 and port 3847", () => {
    const opts = parseArgs(["serve"]);
    expect(opts.command).toBe("serve");
    expect(opts.host).toBe(DEFAULT_HOST);
    expect(opts.host).toBe("127.0.0.1");
    expect(opts.port).toBe(DEFAULT_PORT);
    expect(opts.port).toBe(3847);
    expect(opts.repo).toBeUndefined();
  });

  test("parseArgs accepts --host/--port/--repo", () => {
    const opts = parseArgs([
      "serve",
      "--host",
      "0.0.0.0",
      "--port",
      "9999",
      "--repo",
      "/tmp/boards",
    ]);
    expect(opts.host).toBe("0.0.0.0");
    expect(opts.port).toBe(9999);
    expect(opts.repo).toBe("/tmp/boards");
  });

  test("LOOPBACK_HOSTS / isLoopbackHost cover 127.0.0.1, localhost, ::1", () => {
    expect(LOOPBACK_HOSTS.has("127.0.0.1")).toBe(true);
    expect(LOOPBACK_HOSTS.has("localhost")).toBe(true);
    expect(LOOPBACK_HOSTS.has("::1")).toBe(true);
    expect(LOOPBACK_HOSTS.has("0.0.0.0")).toBe(false);
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
  });

  test("warnIfPublicBind is silent (null) on loopback hosts", () => {
    for (const host of ["127.0.0.1", "localhost", "::1"]) {
      expect(warnIfPublicBind(host)).toBeNull();
    }
  });

  test("warnIfPublicBind emits loud WARNING on non-loopback (0.0.0.0)", () => {
    const msg = warnIfPublicBind("0.0.0.0");
    expect(msg).not.toBeNull();
    expect(msg!).toContain("WARNING");
    expect(msg!).toContain("0.0.0.0");
    expect(msg!).toContain("not loopback");
    expect(msg!).toContain("NO authentication");
    expect(msg!).toContain("127.0.0.1");
  });

  test("startServer defaults hostname to 127.0.0.1 when host omitted", async () => {
    const port = await freePort();
    const server = startServer({ port });
    cleanups.push(() => server.stop(true));
    expect(server.hostname).toBe("127.0.0.1");
    const res = await fetch(`http://127.0.0.1:${server.port}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });
});
