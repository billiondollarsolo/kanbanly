import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Card, CardFrontmatter } from "./card.ts";
import { parseCard, serializeCard } from "./card.ts";

/**
 * Three-way card merge.
 * - frontmatter: higher `updated` wins for the whole frontmatter set (except we
 *   merge field-wise preferring the side with higher updated)
 * - ## Status: higher `updated` wins
 * - ## Log: union, dedupe, re-sort by date prefix
 * Never produces duplicate-keyed YAML.
 */

function updatedMs(iso: string): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

function pickFrontmatter(
  base: CardFrontmatter,
  ours: CardFrontmatter,
  theirs: CardFrontmatter,
): CardFrontmatter {
  const ourNewer = updatedMs(ours.updated) >= updatedMs(theirs.updated);
  const winner = ourNewer ? ours : theirs;
  const loser = ourNewer ? theirs : ours;

  // Prefer winner's fields; if a field only changed on the loser side vs base,
  // and winner left it equal to base, take the loser's change when timestamps
  // are equal we still take winner (ours preferred on ties via >=).
  // Spec: "higher updated wins" for frontmatter as a unit — use winner wholesale
  // for required identity fields, but keep id from base/ours (ids don't change).
  return {
    ...loser,
    ...winner,
    id: base.id || ours.id || theirs.id,
    // Explicitly ensure single values
    column: winner.column,
    title: winner.title,
    order: winner.order,
    updated:
      updatedMs(ours.updated) >= updatedMs(theirs.updated)
        ? ours.updated
        : theirs.updated,
  };
}

/** Parse a log line's leading date (YYYY-MM-DD) for sorting; missing → epoch. */
function logSortKey(line: string): string {
  const m = line.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1]! : "0000-00-00";
}

export function mergeLog(ours: string[], theirs: string[], base: string[] = []): string[] {
  const set = new Set<string>();
  // Union all three, prefer keeping order stability via sort
  for (const line of [...base, ...ours, ...theirs]) {
    const trimmed = line.trim();
    if (trimmed.length > 0) set.add(trimmed);
  }
  return [...set].sort((a, b) => {
    const ka = logSortKey(a);
    const kb = logSortKey(b);
    if (ka < kb) return -1;
    if (ka > kb) return 1;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

export function mergeCards(base: Card, ours: Card, theirs: Card): Card {
  const frontmatter = pickFrontmatter(base.frontmatter, ours.frontmatter, theirs.frontmatter);
  const ourNewer = updatedMs(ours.frontmatter.updated) >= updatedMs(theirs.frontmatter.updated);
  const status = ourNewer ? ours.status : theirs.status;
  const log = mergeLog(ours.log, theirs.log, base.log);

  return { frontmatter, status, log };
}

/**
 * Merge three card file texts. Returns serialized result.
 * If any side fails to parse, falls back to the side with higher updated when possible.
 */
export function mergeCardTexts(baseText: string, oursText: string, theirsText: string): string {
  const baseR = parseCard(baseText);
  const oursR = parseCard(oursText);
  const theirsR = parseCard(theirsText);

  if (!oursR.ok && !theirsR.ok) {
    // Both broken — return ours as-is
    return oursText;
  }
  if (!oursR.ok && theirsR.ok) return serializeCard(theirsR.card);
  if (oursR.ok && !theirsR.ok) return serializeCard(oursR.card);

  // Both ours and theirs parse successfully from here.
  const oursCard = oursR.ok ? oursR.card : null;
  const theirsCard = theirsR.ok ? theirsR.card : null;
  if (!oursCard || !theirsCard) return oursText;

  const baseCard = baseR.ok ? baseR.card : oursCard;
  const merged = mergeCards(baseCard, oursCard, theirsCard);
  return serializeCard(merged);
}

/**
 * CLI-shaped merge driver entry: reads three file paths, writes result to "ours" path.
 * Pure Node fs — works under Bun and Node (NFR-9).
 */
export function runMergeDriverSync(
  ancestorPath: string,
  oursPath: string,
  theirsPath: string,
): void {
  const base = existsSync(ancestorPath)
    ? readFileSync(ancestorPath, "utf8")
    : "";
  const ours = readFileSync(oursPath, "utf8");
  const theirs = readFileSync(theirsPath, "utf8");
  const result = mergeCardTexts(base, ours, theirs);
  writeFileSync(oursPath, result, "utf8");
}

/** Async wrapper (CLI / tests). */
export async function runMergeDriver(
  ancestorPath: string,
  oursPath: string,
  theirsPath: string,
): Promise<void> {
  runMergeDriverSync(ancestorPath, oursPath, theirsPath);
}
