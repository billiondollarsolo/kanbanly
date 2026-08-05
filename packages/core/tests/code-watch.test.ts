import { describe, expect, test } from "bun:test";
import {
  commitSubject,
  parseGitHubRemote,
  watchGitHubCommits,
} from "../src/code-watch.ts";
import { mergeCodeBindingSettings, resolveCodeBinding } from "../src/project-cockpit.ts";

describe("parseGitHubRemote", () => {
  test("https with and without .git", () => {
    expect(parseGitHubRemote("https://github.com/org/repo.git")).toEqual({
      owner: "org",
      repo: "repo",
    });
    expect(parseGitHubRemote("https://github.com/org/repo")).toEqual({
      owner: "org",
      repo: "repo",
    });
  });

  test("ssh form", () => {
    expect(parseGitHubRemote("git@github.com:org/repo.git")).toEqual({
      owner: "org",
      repo: "repo",
    });
  });

  test("strips embedded credentials so tokens never reach the URL we build", () => {
    expect(
      parseGitHubRemote("https://x-access-token:ghp_secret@github.com/org/repo.git"),
    ).toEqual({ owner: "org", repo: "repo" });
  });

  test("non-github hosts return null so callers fall back to cloning", () => {
    expect(parseGitHubRemote("https://gitlab.com/org/repo.git")).toBeNull();
    expect(parseGitHubRemote("git@bitbucket.org:org/repo.git")).toBeNull();
    expect(parseGitHubRemote("")).toBeNull();
    expect(parseGitHubRemote(null)).toBeNull();
  });
});

describe("commitSubject", () => {
  test("takes the first line only", () => {
    expect(commitSubject("c-1a2b add parser\n\nlong body\nmore")).toBe(
      "c-1a2b add parser",
    );
  });
  test("handles empty input", () => {
    expect(commitSubject("")).toBe("");
    expect(commitSubject(undefined)).toBe("");
  });
});

function fakeFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
  return (async () =>
    ({
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
      json: async () => body,
    }) as unknown as Response) as unknown as typeof fetch;
}

describe("watchGitHubCommits", () => {
  const payload = [
    {
      sha: "abc1234def",
      commit: {
        message: "c-1a2b add parser\n\nbody",
        author: { name: "Rina", date: "2026-08-05T10:00:00Z" },
      },
    },
    {
      sha: "999888777",
      commit: { message: "chore: bump", author: { name: "Deo", date: "2026-08-04T09:00:00Z" } },
    },
  ];

  test("maps API commits to ProjectCommit shape", async () => {
    const r = await watchGitHubCommits({
      remote: "https://github.com/org/repo.git",
      token: "t",
      fetchImpl: fakeFetch(200, payload, { "x-ratelimit-remaining": "4999" }),
    });
    expect(r.ok).toBe(true);
    expect(r.commits).toEqual([
      { sha: "abc1234def", date: "2026-08-05T10:00:00Z", author: "Rina", subject: "c-1a2b add parser" },
      { sha: "999888777", date: "2026-08-04T09:00:00Z", author: "Deo", subject: "chore: bump" },
    ]);
    expect(r.rateRemaining).toBe(4999);
  });

  test("non-github remote is rejected without a network call", async () => {
    let called = false;
    const r = await watchGitHubCommits({
      remote: "https://gitlab.com/org/repo.git",
      fetchImpl: (async () => {
        called = true;
        return {} as Response;
      }) as unknown as typeof fetch,
    });
    expect(called).toBe(false);
    expect(r.ok).toBe(false);
    expect(r.commits).toEqual([]);
  });

  test("404 degrades to no commits with a useful message, never throws", async () => {
    const r = await watchGitHubCommits({
      remote: "https://github.com/org/private",
      fetchImpl: fakeFetch(404, {}),
    });
    expect(r.ok).toBe(false);
    expect(r.commits).toEqual([]);
    expect(r.error).toContain("credential");
  });

  test("a thrown fetch degrades instead of propagating", async () => {
    const r = await watchGitHubCommits({
      remote: "https://github.com/org/repo",
      fetchImpl: (async () => {
        throw new Error("offline");
      }) as unknown as typeof fetch,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("offline");
  });

  test("malformed entries are skipped, not fatal", async () => {
    const r = await watchGitHubCommits({
      remote: "https://github.com/org/repo",
      fetchImpl: fakeFetch(200, [{ nope: true }, payload[0]]),
    });
    expect(r.ok).toBe(true);
    expect(r.commits.length).toBe(1);
  });
});

describe("watch binding round-trip", () => {
  test("watch survives merge → resolve", () => {
    const settings = mergeCodeBindingSettings(
      {},
      { remote: "https://github.com/org/repo.git", watch: true },
    );
    expect((settings.code as Record<string, unknown>).watch).toBe(true);
    const b = resolveCodeBinding(settings);
    expect(b?.watch).toBe(true);
    expect(b?.remote).toBe("https://github.com/org/repo.git");
  });

  test("absent watch stays undefined so clone remains the default", () => {
    const settings = mergeCodeBindingSettings({}, { remote: "https://github.com/o/r" });
    expect(resolveCodeBinding(settings)?.watch).toBeUndefined();
  });
});
