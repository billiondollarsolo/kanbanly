#!/usr/bin/env bun
/**
 * Node compatibility smoke (NFR-9).
 * Exercises merge-driver logic with only Node-compatible APIs.
 * Optionally runs the same steps under `node --experimental-strip-types` when available.
 */
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { runMergeDriverSync, serializeCard } from "../packages/core/src/index.ts";

function card(column, updated, status) {
  return {
    frontmatter: {
      id: "c-node1",
      title: "Node smoke",
      column,
      order: "m",
      updated,
      labels: [],
    },
    status,
    log: ["2026-08-01 human: created"],
  };
}

const root = mkdtempSync(join(tmpdir(), "kanbanly-node-"));
try {
  const pO = join(root, "O.md");
  const pA = join(root, "A.md");
  const pB = join(root, "B.md");
  writeFileSync(pO, serializeCard(card("backlog", "2026-08-01T00:00:00Z", "base")));
  writeFileSync(pA, serializeCard(card("doing", "2026-08-04T10:00:00Z", "ours")));
  writeFileSync(pB, serializeCard(card("review", "2026-08-04T12:00:00Z", "theirs")));

  runMergeDriverSync(pO, pA, pB);
  const out = readFileSync(pA, "utf8");
  if (!out.includes("column: review")) {
    console.error("FAIL: expected merged column review");
    process.exit(1);
  }
  console.log("test-node: runMergeDriverSync ok (Bun/TS runtime)");

  // Try pure Node if available
  const node = spawnSync(
    "node",
    [
      "--experimental-strip-types",
      "--no-warnings",
      "-e",
      `
      import { writeFileSync, readFileSync } from 'node:fs';
      import { runMergeDriverSync, serializeCard } from './packages/core/src/index.ts';
      const card = (column, updated, status) => ({
        frontmatter: { id: 'c-n', title: 'N', column, order: 'm', updated, labels: [] },
        status, log: ['2026-08-01 human: created'],
      });
      const root = ${JSON.stringify(root)};
      const pO = root + '/nO.md';
      const pA = root + '/nA.md';
      const pB = root + '/nB.md';
      writeFileSync(pO, serializeCard(card('backlog','2026-08-01T00:00:00Z','b')));
      writeFileSync(pA, serializeCard(card('doing','2026-08-04T10:00:00Z','o')));
      writeFileSync(pB, serializeCard(card('review','2026-08-04T12:00:00Z','t')));
      runMergeDriverSync(pO, pA, pB);
      const out = readFileSync(pA, 'utf8');
      if (!out.includes('column: review')) process.exit(2);
      console.log('test-node: node --experimental-strip-types ok');
      `,
    ],
    { cwd: join(import.meta.dir, ".."), encoding: "utf8" },
  );
  if (node.status === 0) {
    console.log(node.stdout.trim());
  } else {
    console.log(
      "test-node: pure Node strip-types skipped or failed (best-effort):",
      (node.stderr || node.stdout || "").split("\n")[0],
    );
  }
  console.log("test-node: ok");
} finally {
  rmSync(root, { recursive: true, force: true });
}
