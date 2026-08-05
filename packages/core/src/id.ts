const HEX = "0123456789abcdef";

export type RandomFn = () => number;

/** Default unseeded random in [0, 1). */
const defaultRandom: RandomFn = () => Math.random();

/** Trello/MongoDB-style object id length (24 hex chars = 96 bits). */
export const DEFAULT_ID_HEX_LENGTH = 24;

/** Allowed suffix length range for card/board ids. */
export const ID_HEX_LENGTH_MIN = 8;
export const ID_HEX_LENGTH_MAX = 32;

function randomHex(
  length: number,
  random: RandomFn,
): string {
  let out = "";
  for (let i = 0; i < length; i++) {
    out += HEX[Math.floor(random() * 16)]!;
  }
  return out;
}

function assertHexLength(length: number, kind: string): void {
  if (length < ID_HEX_LENGTH_MIN || length > ID_HEX_LENGTH_MAX) {
    throw new Error(
      `${kind} id hex length must be ${ID_HEX_LENGTH_MIN}–${ID_HEX_LENGTH_MAX}`,
    );
  }
}

/**
 * Generate a collision-free card id: `c-` + 24 hex chars (Trello-style).
 * Shared by OSS and SaaS via `@kanbanly/core`. Retries until not in `existingIds`.
 */
export function generateCardId(
  existingIds: Iterable<string>,
  options?: { length?: number; random?: RandomFn; maxAttempts?: number },
): string {
  const length = options?.length ?? DEFAULT_ID_HEX_LENGTH;
  assertHexLength(length, "Card");
  const random = options?.random ?? defaultRandom;
  const maxAttempts = options?.maxAttempts ?? 10_000;
  const existing = new Set(existingIds);

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const id = `c-${randomHex(length, random)}`;
    if (!existing.has(id)) return id;
  }
  throw new Error(`Failed to generate unique card id after ${maxAttempts} attempts`);
}

/** Slugify a title for use in a filename. */
export function slugifyTitle(title: string, maxLen = 80): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLen)
    .replace(/-+$/g, "");
  return slug.length > 0 ? slug : "card";
}

/** Build card filename: `<id>-<slugified-title>.md`. */
export function cardFilename(id: string, title: string): string {
  return `${id}-${slugifyTitle(title)}.md`;
}

/**
 * Generate a collision-free board id: `b-` + 24 hex chars (Trello-style).
 * Directory name on disk for layout A boards. Shared by OSS and SaaS.
 */
export function generateBoardId(
  existingIds: Iterable<string>,
  options?: { length?: number; random?: RandomFn; maxAttempts?: number },
): string {
  const length = options?.length ?? DEFAULT_ID_HEX_LENGTH;
  assertHexLength(length, "Board");
  const random = options?.random ?? defaultRandom;
  const maxAttempts = options?.maxAttempts ?? 10_000;
  const existing = new Set(existingIds);

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const id = `b-${randomHex(length, random)}`;
    if (!existing.has(id)) return id;
  }
  throw new Error(
    `Failed to generate unique board id after ${maxAttempts} attempts`,
  );
}
