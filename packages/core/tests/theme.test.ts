import { describe, expect, test } from "bun:test";
import {
  isThemePreference,
  resolveTheme,
  themeBootScript,
  THEME_STORAGE_KEY,
} from "../src/theme.ts";

describe("resolveTheme", () => {
  test("light and dark override system", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  test("system follows prefers-color-scheme", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });
});

describe("theme helpers", () => {
  test("isThemePreference", () => {
    expect(isThemePreference("system")).toBe(true);
    expect(isThemePreference("nope")).toBe(false);
  });

  test("boot script mentions storage key and data-theme", () => {
    const s = themeBootScript();
    expect(s).toContain(THEME_STORAGE_KEY);
    expect(s).toContain("data-theme");
    expect(s).toContain("localStorage");
  });
});
