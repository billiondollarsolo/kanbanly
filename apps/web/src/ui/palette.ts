/**
 * Accent palette + the pure hashing helpers that derive stable colours and
 * initials from arbitrary strings (column ids, label names, actor names).
 *
 * Moved out of Board.tsx verbatim: these are dependency-free pure functions
 * consumed by the column headers, the card modal stripe, the label chips, the
 * portfolio tiles and the card log, so they belong in a module every one of
 * those can import without pulling in the board.
 */

/**
 * Stable per-column accent (design color bar). Pure function of the column id
 * so the column header bar and the card modal stripe always agree.
 */
export const ACCENT_PALETTE = [
  "#4a7dbd",
  "#3f9c8f",
  "#5f9c4f",
  "#c08a2e",
  "#c0563e",
  "#8a6bc0",
  "#bb5f8a",
  "#77808a",
];

/** FNV-1a — spreads short lowercase ids across the palette far better than a
 *  positional char sum, which clustered real column names onto 2-3 hues. */
export function hashKey(key: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

export function paletteFor(key: string): string {
  return ACCENT_PALETTE[hashKey(key) % ACCENT_PALETTE.length]!;
}

export function columnAccent(columnId: string): string {
  return paletteFor(columnId);
}

/**
 * Accent per column for one board. Hashing alone still collides, and two
 * adjacent columns sharing a hue reads as a bug — so a taken slot walks to the
 * next free one. Stable for a given column set; falls back to plain hashing
 * once every palette entry is spoken for.
 */
export function columnAccents(ids: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const used = new Set<number>();
  for (const id of ids) {
    let idx = hashKey(id) % ACCENT_PALETTE.length;
    if (used.size < ACCENT_PALETTE.length) {
      while (used.has(idx)) idx = (idx + 1) % ACCENT_PALETTE.length;
      used.add(idx);
    }
    out[id] = ACCENT_PALETTE[idx]!;
  }
  return out;
}

/**
 * Per-label colour. The design gives every label its own hue; kanbanly labels
 * are plain strings, so the hue is derived from the name and stays stable.
 */
export function labelColor(label: string): string {
  return paletteFor(label.toLowerCase());
}

/** Actor name → avatar initials ("Rina Kovacs" → "RK", "claude" → "CL"). */
export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0]!.charAt(0) + parts[1]!.charAt(0)).toUpperCase();
  }
  return (parts[0] ?? "?").slice(0, 2).toUpperCase();
}
