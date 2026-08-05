import { parseCard, serializeCard, type Card } from "./card.ts";
import { mergeCards } from "./merge.ts";

export function hasConflictMarkers(text: string): boolean {
  return text.includes("<<<<<<<") && text.includes("=======") && text.includes(">>>>>>>");
}

/**
 * Extract ours / theirs sides from a conflict-markered file.
 * Supports multiple conflict regions by concatenating sides.
 * Handles both whole-file and partial (inline) conflicts.
 */
export function extractConflictSides(text: string): { ours: string; theirs: string } | null {
  if (!hasConflictMarkers(text)) return null;

  let ours = "";
  let theirs = "";
  let rest = text;

  while (rest.includes("<<<<<<<")) {
    const start = rest.indexOf("<<<<<<<");
    if (start < 0) break;

    // preamble before marker goes to both sides
    const preamble = rest.slice(0, start);
    ours += preamble;
    theirs += preamble;

    // skip the <<<<<<< line
    const afterStart = rest.indexOf("\n", start);
    if (afterStart < 0) {
      rest = "";
      break;
    }
    rest = rest.slice(afterStart + 1);

    const mid = rest.indexOf("=======");
    if (mid < 0) {
      ours += rest;
      break;
    }
    ours += rest.slice(0, mid);

    // skip the ======= line
    const afterMid = rest.indexOf("\n", mid);
    if (afterMid < 0) {
      rest = "";
      break;
    }
    rest = rest.slice(afterMid + 1);

    const end = rest.indexOf(">>>>>>>");
    if (end < 0) {
      theirs += rest;
      rest = "";
      break;
    }
    theirs += rest.slice(0, end);

    // skip the >>>>>>> line
    const afterEnd = rest.indexOf("\n", end);
    if (afterEnd < 0) {
      rest = "";
      break;
    }
    rest = rest.slice(afterEnd + 1);
  }
  ours += rest;
  theirs += rest;

  return { ours, theirs };
}

export type ConflictResolveChoice = "mine" | "theirs" | "heal";

/**
 * Resolve conflict-markered text by side.
 * - mine: keep ours (HEAD / local)
 * - theirs: keep theirs (incoming)
 * - heal: three-way merge via mergeCards
 */
export function resolveConflictText(
  text: string,
  choice: ConflictResolveChoice,
): string {
  if (!hasConflictMarkers(text)) return text;
  const sides = extractConflictSides(text);
  if (!sides) return text;
  if (choice === "mine") return sides.ours;
  if (choice === "theirs") return sides.theirs;
  return healConflict(text);
}

/**
 * Resolve when both sides are already split (no markers required).
 */
export function resolveConflictSides(
  ours: string,
  theirs: string,
  choice: ConflictResolveChoice,
): string {
  if (choice === "mine") return ours;
  if (choice === "theirs") return theirs;
  // Synthetic whole-file markers so healConflict can run
  const synthetic = `<<<<<<< HEAD\n${ours}=======\n${theirs}>>>>>>> theirs\n`;
  return healConflict(synthetic);
}

/**
 * Heal a card file that may contain git conflict markers.
 * Returns unchanged text when no markers are present.
 * Uses mergeCards with the older side as pseudo-base.
 */
export function healConflict(text: string): string {
  if (!hasConflictMarkers(text)) return text;

  const sides = extractConflictSides(text);
  if (!sides) return text;

  const oursR = parseCard(sides.ours);
  const theirsR = parseCard(sides.theirs);

  if (!oursR.ok && !theirsR.ok) {
    // Can't parse either — strip markers best-effort by keeping reconstructed ours
    return sides.ours;
  }
  if (!oursR.ok && theirsR.ok) return serializeCard(theirsR.card);
  if (oursR.ok && !theirsR.ok) return serializeCard(oursR.card);
  if (!oursR.ok || !theirsR.ok) return sides.ours;

  const ours = oursR.card;
  const theirs = theirsR.card;
  const ourMs = Date.parse(ours.frontmatter.updated) || 0;
  const theirMs = Date.parse(theirs.frontmatter.updated) || 0;
  const base: Card = ourMs <= theirMs ? ours : theirs;

  const merged = mergeCards(base, ours, theirs);
  return serializeCard(merged);
}
