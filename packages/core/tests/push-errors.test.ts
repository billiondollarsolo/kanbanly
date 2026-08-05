import { describe, expect, test } from "bun:test";
import { classifyPushError } from "../src/push-errors.ts";

describe("classifyPushError", () => {
  test("offline / network", () => {
    const c = classifyPushError("fatal: unable to access 'https://...': Could not resolve host");
    expect(c.kind).toBe("offline");
    expect(c.localWritesOk).toBe(true);
    expect(c.freezeSync).toBe(false);
    expect(c.title).toMatch(/offline/i);
  });

  test("credential / auth", () => {
    const c = classifyPushError(
      "remote: Invalid username or token. Password authentication failed.",
    );
    expect(c.kind).toBe("credential");
    expect(c.detail).toMatch(/credential|PAT|SSH|Authentication/i);
  });

  test("real 401 from remote", () => {
    const c = classifyPushError(
      "remote: HTTP Basic: Access denied\nfatal: Authentication failed for 'https://github.com/x/y.git/' (HTTP 401)",
    );
    expect(c.kind).toBe("credential");
    expect(c.title).toMatch(/401/);
    expect(c.detail).toMatch(/Authentication failed|re-enter/i);
  });

  test("real 403 with missing scope", () => {
    const c = classifyPushError(
      "remote: Write access to repository not granted.\nfatal: unable to access: The requested URL returned error: 403\nmissing scopes: repo, workflow",
    );
    expect(c.kind).toBe("credential");
    expect(c.title).toMatch(/403/);
    expect(c.detail).toMatch(/scope/i);
  });

  test("credential with scope hint", () => {
    const c = classifyPushError("HTTP 403: missing scope: repo");
    expect(c.kind).toBe("credential");
    expect(c.detail).toMatch(/scope/i);
  });

  test("conflict freezes sync", () => {
    const c = classifyPushError("CONFLICT (content): Merge conflict in cards/c-1.md", {
      files: ["cards/c-1.md"],
    });
    expect(c.kind).toBe("conflict");
    expect(c.freezeSync).toBe(true);
    expect(c.detail).toMatch(/c-1\.md/);
  });

  test("unknown fallback", () => {
    const c = classifyPushError("something weird happened");
    expect(c.kind).toBe("unknown");
  });
});
