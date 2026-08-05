/**
 * Watch a bound source repo through the forge API instead of cloning it.
 *
 * The clone path (see code-repo.ts) fetches every blob in history just to read
 * commit subjects. Everything kanbanly does with a bound repo — commit→card
 * linking, code velocity counts, the `source` badge — needs commit METADATA
 * only, so for GitHub remotes we can read it over HTTPS and keep zero local
 * state.
 *
 * Deliberately separate from GitStorage.codeHistory(), which is synchronous:
 * making it async to accommodate a network call would ripple through every
 * caller. The server route is already async and branches to this instead.
 */

import type { ProjectCommit } from "./project-cockpit.ts";

export type GitHubRepoRef = { owner: string; repo: string };

/**
 * Extract owner/repo from the remote forms a board may carry.
 * Returns null for anything that is not github.com, so callers fall back to the
 * clone path rather than silently reporting no commits.
 */
export function parseGitHubRemote(
  remote: string | undefined | null,
): GitHubRepoRef | null {
  const raw = (remote ?? "").trim();
  if (!raw) return null;

  // git@github.com:owner/repo.git
  const ssh = raw.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/i);
  if (ssh) return { owner: ssh[1]!, repo: ssh[2]! };

  // https://github.com/owner/repo(.git), optionally with embedded credentials
  const https = raw.match(
    /^https?:\/\/(?:[^@/]*@)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i,
  );
  if (https) return { owner: https[1]!, repo: https[2]! };

  return null;
}

/** First line of a commit message — the subject kanbanly scans for card ids. */
export function commitSubject(message: string | undefined | null): string {
  return (message ?? "").split("\n", 1)[0]!.trim();
}

export type WatchCommitsResult = {
  ok: boolean;
  commits: ProjectCommit[];
  /** Present when ok is false — surfaced to the UI, never thrown. */
  error?: string;
  /** Rate-limit remaining, when GitHub reported it. */
  rateRemaining?: number | null;
};

/**
 * Read recent commits for a GitHub repo over the API. Never throws: a watch
 * failure must degrade to "no commits" rather than break the board.
 */
export async function watchGitHubCommits(options: {
  remote: string;
  token?: string | null;
  limit?: number;
  fetchImpl?: typeof fetch;
}): Promise<WatchCommitsResult> {
  const ref = parseGitHubRemote(options.remote);
  if (!ref) {
    return {
      ok: false,
      commits: [],
      error: "Watch mode supports github.com remotes only",
    };
  }

  const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
  const fetchFn = options.fetchImpl ?? fetch;
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "kanbanly",
    "x-github-api-version": "2022-11-28",
  };
  if (options.token) headers.authorization = `Bearer ${options.token}`;

  try {
    const url =
      `https://api.github.com/repos/${encodeURIComponent(ref.owner)}/` +
      `${encodeURIComponent(ref.repo)}/commits?per_page=${limit}`;
    const res = await fetchFn(url, { headers });
    const rateRemaining = numberOrNull(
      res.headers?.get?.("x-ratelimit-remaining"),
    );

    if (!res.ok) {
      return {
        ok: false,
        commits: [],
        rateRemaining,
        error: describeHttpError(res.status, !!options.token),
      };
    }

    const body = (await res.json()) as unknown;
    if (!Array.isArray(body)) {
      return { ok: false, commits: [], rateRemaining, error: "Unexpected API response" };
    }

    const commits: ProjectCommit[] = [];
    for (const entry of body) {
      const e = entry as {
        sha?: unknown;
        commit?: { message?: unknown; author?: { name?: unknown; date?: unknown } };
        author?: { login?: unknown } | null;
      };
      if (typeof e.sha !== "string") continue;
      const authorName =
        typeof e.commit?.author?.name === "string"
          ? e.commit.author.name
          : typeof e.author?.login === "string"
            ? e.author.login
            : "unknown";
      commits.push({
        sha: e.sha,
        date:
          typeof e.commit?.author?.date === "string" ? e.commit.author.date : "",
        author: authorName,
        subject: commitSubject(
          typeof e.commit?.message === "string" ? e.commit.message : "",
        ),
      });
    }
    return { ok: true, commits, rateRemaining };
  } catch (cause) {
    return {
      ok: false,
      commits: [],
      error: `Watch request failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }
}

function numberOrNull(v: string | null | undefined): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function describeHttpError(status: number, hadToken: boolean): string {
  if (status === 404) {
    return hadToken
      ? "Repository not found, or the credential cannot see it"
      : "Repository not found (private repos need a credential)";
  }
  if (status === 401) return "Credential rejected by GitHub (401)";
  if (status === 403) return "Forbidden or rate-limited by GitHub (403)";
  return `GitHub API error ${status}`;
}
