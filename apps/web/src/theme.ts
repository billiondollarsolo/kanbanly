import {
  THEME_STORAGE_KEY,
  isThemePreference,
  resolveTheme,
  type ResolvedTheme,
  type ThemePreference,
} from "@kanbanly/core";

export type { ThemePreference, ResolvedTheme };

export function readThemePreference(): ThemePreference {
  try {
    const v = localStorage.getItem(THEME_STORAGE_KEY);
    if (isThemePreference(v)) return v;
  } catch {
    /* ignore */
  }
  return "system";
}

export function systemPrefersDark(): boolean {
  return (
    typeof window !== "undefined" &&
    !!window.matchMedia?.("(prefers-color-scheme: dark)").matches
  );
}

export function applyTheme(preference: ThemePreference): ResolvedTheme {
  const resolved = resolveTheme(preference, systemPrefersDark());
  document.documentElement.setAttribute("data-theme", resolved);
  document.documentElement.setAttribute("data-theme-pref", preference);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    /* ignore */
  }
  return resolved;
}

/**
 * When preference is "system", re-apply when the OS color scheme changes (US-32).
 * Returns unsubscribe.
 */
export function watchSystemTheme(
  getPreference: () => ThemePreference,
  onResolved?: (r: ResolvedTheme) => void,
): () => void {
  if (typeof window === "undefined" || !window.matchMedia) {
    return () => undefined;
  }
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const handler = () => {
    if (getPreference() === "system") {
      const r = applyTheme("system");
      onResolved?.(r);
    }
  };
  if (typeof mq.addEventListener === "function") {
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }
  // Safari < 14
  mq.addListener(handler);
  return () => mq.removeListener(handler);
}
