import { describe, expect, test } from "bun:test";
import {
  isLoopbackHost,
  parseArgs,
  warnIfPublicBind,
} from "../src/cli.ts";

describe("CLI bind defaults (NFR-5)", () => {
  test("parseArgs defaults host to 127.0.0.1", () => {
    const opts = parseArgs(["serve"]);
    expect(opts.command).toBe("serve");
    expect(opts.host).toBe("127.0.0.1");
    expect(opts.port).toBe(3847);
  });

  test("parseArgs accepts --host and --port overrides", () => {
    const opts = parseArgs(["serve", "--host", "0.0.0.0", "--port", "9999"]);
    expect(opts.host).toBe("0.0.0.0");
    expect(opts.port).toBe(9999);
  });

  test("loopback hosts need no warning", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(warnIfPublicBind("127.0.0.1")).toBeNull();
  });

  test("non-loopback host produces loud warning text", () => {
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    const msg = warnIfPublicBind("0.0.0.0");
    expect(msg).toBeTruthy();
    expect(msg!).toMatch(/WARNING/i);
    expect(msg!).toMatch(/0\.0\.0\.0/);
    expect(msg!).toMatch(/NO authentication/i);
  });
});
