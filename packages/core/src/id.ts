const BASE36 = "0123456789abcdefghijklmnopqrstuvwxyz";

export type RandomFn = () => number;

/** Default unseeded random in [0, 1). */
const defaultRandom: RandomFn = () => Math.random();

/**
 * Generate a collision-free card id: `c-` + 4–6 random base36 chars.
 * Retries until the id is not in `existingIds`.
 */
export function generateCardId(
  existingIds: Iterable<string>,
  options?: { length?: number; random?: RandomFn; maxAttempts?: number },
): string {
  const length = options?.length ?? 4;
  if (length < 4 || length > 6) {
    throw new Error("Card id suffix length must be 4–6");
  }
  const random = options?.random ?? defaultRandom;
  const maxAttempts = options?.maxAttempts ?? 10_000;
  const existing = new Set(existingIds);

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let suffix = "";
    for (let i = 0; i < length; i++) {
      const idx = Math.floor(random() * 36);
      suffix += BASE36[idx]!;
    }
    // Occasionally extend length on many collisions (still within 4–6)
    if (attempt > 100 && length < 6) {
      // fall through with longer generation via recursive-style extra chars
    }
    const id = `c-${suffix}`;
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
