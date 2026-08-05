/**
 * Theme preference: light | dark | system.
 * Pure helpers for resolve + storage key (UI applies DOM).
 */

export type ThemePreference = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "kanbanly-theme";

export function isThemePreference(v: unknown): v is ThemePreference {
  return v === "light" || v === "dark" || v === "system";
}

/** Resolve preference against current system preference. */
export function resolveTheme(
  preference: ThemePreference,
  systemPrefersDark: boolean,
): ResolvedTheme {
  if (preference === "light") return "light";
  if (preference === "dark") return "dark";
  return systemPrefersDark ? "dark" : "light";
}

/**
 * Inline script body for FOUC-free boot (run before paint).
 * Reads localStorage and sets data-theme on <html>.
 */
export function themeBootScript(storageKey = THEME_STORAGE_KEY): string {
  return `(function(){try{var k=${JSON.stringify(storageKey)};var p=localStorage.getItem(k)||"system";if(p!=="light"&&p!=="dark"&&p!=="system")p="system";var dark=window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches;var r=p==="light"?"light":p==="dark"?"dark":(dark?"dark":"light");document.documentElement.setAttribute("data-theme",r);document.documentElement.setAttribute("data-theme-pref",p);}catch(e){document.documentElement.setAttribute("data-theme","dark");}})();`;
}
