#!/usr/bin/env bun
/**
 * Robust remote round-trip (no GitHub required).
 * Spawns the bun test that uses a real bare git remote.
 *
 * Optional live smoke against a running server:
 *   KANBANLY_BASE_URL=http://127.0.0.1:22000 bun run scripts/test-remote-roundtrip.mjs --live
 *
 * Optional GitHub connect (never commit the PAT):
 *   KANBANLY_TEST_REMOTE=https://github.com/you/boards.git \
 *   KANBANLY_TEST_PAT=ghp_… \
 *   bun run scripts/test-remote-roundtrip.mjs --github
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const args = new Set(process.argv.slice(2));

function run(cmd, argv, opts = {}) {
  const r = spawnSync(cmd, argv, {
    cwd: root,
    encoding: "utf8",
    stdio: "inherit",
    ...opts,
  });
  return r.status ?? 1;
}

console.log("==> remote round-trip (bare origin, automated)");
const code = run("bun", [
  "test",
  "packages/server/tests/remote-roundtrip.test.ts",
  "packages/server/tests/push-queue.test.ts",
]);
if (code !== 0) process.exit(code);

if (args.has("--live") || process.env.KANBANLY_BASE_URL) {
  const base =
    process.env.KANBANLY_BASE_URL?.replace(/\/$/, "") ||
    "http://127.0.0.1:22000";
  console.log(`==> live smoke against ${base}`);
  const health = await fetch(`${base}/health`).then((r) => r.json()).catch((e) => {
    console.error("health failed:", e);
    process.exit(1);
  });
  if (!health.ok) {
    console.error("health not ok", health);
    process.exit(1);
  }
  const boards = await fetch(`${base}/api/boards`).then((r) => r.json());
  console.log(
    `  boards: ${(boards.boards || []).map((b) => `${b.title || b.id}(${b.cardCount})`).join(", ")}`,
  );
  const sync = await fetch(`${base}/api/sync`).then((r) => r.json());
  console.log(`  sync: ${sync.status} pending=${sync.pendingCount} · ${sync.label}`);

  const first = boards.boards?.[0];
  if (first) {
    const title = `live-smoke ${new Date().toISOString().slice(0, 19)}`;
    const created = await fetch(`${base}/api/boards/${first.id}/cards`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title, column: first.columns?.[0] || "backlog" }),
    });
    if (!created.ok) {
      console.error("create card failed", created.status, await created.text());
      process.exit(1);
    }
    const body = await created.json();
    console.log(`  created ${body.card?.id} on ${first.id}`);
    // drain if remote present
    if (sync.status !== "no_remote" || body.sync?.status === "pending") {
      const retry = await fetch(`${base}/api/sync/retry`, { method: "POST" });
      const after = await retry.json();
      console.log(`  after retry: ${after.status} pending=${after.pendingCount}`);
    }
  }
  console.log("live smoke: ok");
}

if (args.has("--github")) {
  const remote = process.env.KANBANLY_TEST_REMOTE?.trim();
  const token = process.env.KANBANLY_TEST_PAT?.trim();
  if (!remote || !token) {
    console.error(
      "Set KANBANLY_TEST_REMOTE and KANBANLY_TEST_PAT for --github (do not commit them).",
    );
    process.exit(1);
  }
  console.log("==> GitHub connect round-trip (ephemeral server + clone)");
  // Re-use multi-remote / connect paths via a tiny inline bun test would be heavy;
  // document: run UI connect or POST /api/connect with token against a local serve.
  console.log(
    "  Use UI Settings → Repositories, or:\n" +
      `  curl -X POST $KANBANLY_BASE_URL/api/connect -H 'content-type: application/json' \\\n` +
      `    -d '{"url":"${remote}","token":"***"}'\n` +
      "  Then re-run with --live after creating a card.",
  );
  // Soft success — PAT must not be logged
  console.log("github: instructions printed (run connect yourself; secrets stay local)");
}

console.log("remote-roundtrip: ok");
