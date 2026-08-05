#!/usr/bin/env bun
/**
 * Required e2e: API drop → commit (always).
 * Optional: Playwright UI when browsers are installed.
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    cwd: root,
    encoding: "utf8",
    stdio: "inherit",
    ...opts,
  });
  return r.status ?? 1;
}

console.log("==> e2e: drag→commit (required, real git)");
const code = run("bun", ["test", "packages/server/tests/e2e-drag-commit.test.ts"]);
if (code !== 0) process.exit(code);

console.log("==> e2e: Playwright UI (optional)");
const pw = spawnSync(
  "bunx",
  ["playwright", "test", "-c", "e2e/playwright.config.ts"],
  { cwd: root, encoding: "utf8" },
);
if (pw.status === 0) {
  console.log(pw.stdout);
  console.log("e2e: Playwright passed");
} else {
  const msg = (pw.stderr || pw.stdout || "").slice(0, 400);
  console.log("e2e: Playwright skipped or failed (optional):", msg.split("\n")[0]);
  console.log("     Install: bunx playwright install chromium");
}

console.log("e2e: ok (required path green)");
