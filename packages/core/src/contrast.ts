/**
 * WCAG contrast helpers for theme validation (NFR-8 / US-32).
 * Relative luminance + contrast ratio per WCAG 2.x.
 */

export type Rgb = { r: number; g: number; b: number };

/** Parse #rgb / #rrggbb (optionally with alpha ignored). */
export function parseHexColor(hex: string): Rgb | null {
  const s = hex.trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{3}$/.test(s)) {
    return {
      r: parseInt(s[0]! + s[0]!, 16),
      g: parseInt(s[1]! + s[1]!, 16),
      b: parseInt(s[2]! + s[2]!, 16),
    };
  }
  if (/^[0-9a-fA-F]{6}$/.test(s)) {
    return {
      r: parseInt(s.slice(0, 2), 16),
      g: parseInt(s.slice(2, 4), 16),
      b: parseInt(s.slice(4, 6), 16),
    };
  }
  return null;
}

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

/** Relative luminance 0–1 (WCAG). */
export function relativeLuminance(rgb: Rgb): number {
  return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
}

/** Contrast ratio between two colors (1–21). */
export function contrastRatio(a: Rgb | string, b: Rgb | string): number {
  const ca = typeof a === "string" ? parseHexColor(a) : a;
  const cb = typeof b === "string" ? parseHexColor(b) : b;
  if (!ca || !cb) return 0;
  const L1 = relativeLuminance(ca);
  const L2 = relativeLuminance(cb);
  const lighter = Math.max(L1, L2);
  const darker = Math.min(L1, L2);
  return (lighter + 0.05) / (darker + 0.05);
}

/** WCAG AA normal text needs ≥ 4.5:1; large text / UI ≥ 3:1. */
export function meetsWcagAa(
  fg: Rgb | string,
  bg: Rgb | string,
  options?: { largeText?: boolean },
): boolean {
  const min = options?.largeText ? 3 : 4.5;
  return contrastRatio(fg, bg) >= min;
}

/** First-class theme palettes used by the OSS board CSS (kept in sync for tests). */
export const THEME_PALETTES = {
  dark: {
    bg: "#0c0e10",
    panel: "#121518",
    card: "#16191d",
    border: "#262b30",
    text: "#e5e8ea",
    muted: "#98a0a6",
    accent: "#8fb4dd",
    drop: "#5f9c4f",
    danger: "#c0563e",
  },
  light: {
    bg: "#f3f3f1",
    panel: "#fafaf9",
    card: "#ffffff",
    border: "#d9d9d4",
    text: "#15171a",
    muted: "#5b6167",
    accent: "#4a7dbd",
    drop: "#5f9c4f",
    danger: "#c0563e",
  },
} as const;

export type ThemePaletteName = keyof typeof THEME_PALETTES;

/**
 * Validate critical pairs for a theme palette.
 * Returns failing pairs (empty when AA-compliant).
 */
export function validateThemeContrast(
  theme: ThemePaletteName,
): Array<{ pair: string; ratio: number; min: number }> {
  const p = THEME_PALETTES[theme];
  const checks: Array<{ pair: string; fg: string; bg: string; min: number }> = [
    { pair: "text on bg", fg: p.text, bg: p.bg, min: 4.5 },
    { pair: "text on panel", fg: p.text, bg: p.panel, min: 4.5 },
    { pair: "text on card", fg: p.text, bg: p.card, min: 4.5 },
    { pair: "muted on panel", fg: p.muted, bg: p.panel, min: 4.5 },
    { pair: "muted on card", fg: p.muted, bg: p.card, min: 4.5 },
    { pair: "accent on panel", fg: p.accent, bg: p.panel, min: 3 }, // UI / large
    { pair: "danger on panel", fg: p.danger, bg: p.panel, min: 3 },
    // Quarantine uses danger-ish text on panel
    { pair: "danger on bg", fg: p.danger, bg: p.bg, min: 3 },
  ];
  const fails: Array<{ pair: string; ratio: number; min: number }> = [];
  for (const c of checks) {
    const ratio = contrastRatio(c.fg, c.bg);
    if (ratio < c.min) fails.push({ pair: c.pair, ratio, min: c.min });
  }
  return fails;
}
