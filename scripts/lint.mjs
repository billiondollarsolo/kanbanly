#!/usr/bin/env bun
/**
 * Lightweight lint without requiring biome install:
 * - no `any` in packages/core & packages/server src (except comments)
 * - no console.log in library packages (console.error allowed in cli)
 * - no TODO/FIXME in src (warn)
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..");
const TARGETS = [
  "packages/core/src",
  "packages/server/src",
  "apps/web/src",
];

const issues = [];

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, acc);
    else if (/\.(ts|tsx)$/.test(name)) acc.push(p);
  }
  return acc;
}

for (const t of TARGETS) {
  const abs = join(ROOT, t);
  let files = [];
  try {
    files = walk(abs);
  } catch {
    continue;
  }
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const rel = relative(ROOT, file);
    const lines = text.split("\n");
    lines.forEach((line, i) => {
      const n = i + 1;
      // bare any types
      if (/:\s*any\b|<any>|as any\b/.test(line) && !line.includes("// lint-allow-any")) {
        issues.push({ rel, n, msg: "avoid `any`", sev: "error" });
      }
      if (
        /console\.log\s*\(/.test(line) &&
        !rel.endsWith("cli.ts") &&
        !line.includes("// lint-allow-console")
      ) {
        issues.push({ rel, n, msg: "no console.log in library code", sev: "error" });
      }
      if (/\bTODO\b|\bFIXME\b/.test(line)) {
        issues.push({ rel, n, msg: "TODO/FIXME left in source", sev: "warn" });
      }
    });
  }
}

const errors = issues.filter((i) => i.sev === "error");
const warns = issues.filter((i) => i.sev === "warn");

for (const i of issues) {
  console.log(`${i.sev === "error" ? "error" : "warn "}: ${i.rel}:${i.n}: ${i.msg}`);
}

console.log(
  `lint: ${errors.length} error(s), ${warns.length} warning(s) across ${TARGETS.join(", ")}`,
);

if (errors.length > 0) process.exit(1);
console.log("lint: ok");
