/**
 * Project/source-code repo helpers: clone-on-demand under ~/.kanbanly/code-clones
 * with optional HTTPS credential (same pattern as boards connect).
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  CredentialStore,
  defaultCredentialPath,
  gitAuthEnv,
  type GitCredential,
} from "./storage/credentials.ts";
import { parseGitLogLines, type ProjectCommit } from "./project-cockpit.ts";

export function defaultCodeCloneRoot(
  home = process.env.HOME ?? homedir(),
): string {
  return join(home, ".kanbanly", "code-clones");
}

export function slugFromCodeRemote(url: string): string {
  const cleaned = url
    .trim()
    .replace(/\.git$/, "")
    .replace(/\/+$/, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const parts = cleaned.split("-").filter(Boolean);
  return (parts.slice(-4).join("-") || "code").slice(0, 80);
}

function embedHttpsCredential(url: string, cred: GitCredential): string {
  if (!cred.token || !/^https?:\/\//i.test(url)) return url;
  try {
    const u = new URL(url);
    u.username = cred.username || "x-access-token";
    u.password = cred.token;
    return u.toString();
  } catch {
    return url;
  }
}

function isGitWorkTree(dir: string): boolean {
  const r = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd: dir,
    encoding: "utf8",
  });
  return r.status === 0 && (r.stdout ?? "").toString().trim() === "true";
}

function runGit(
  cwd: string,
  args: string[],
  env?: Record<string, string>,
): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: env ? { ...process.env, ...env } : process.env,
  });
  return {
    ok: r.status === 0,
    stdout: (r.stdout ?? "").toString(),
    stderr: (r.stderr ?? "").toString(),
  };
}

export type EnsureCodeRepoOptions = {
  /** Local project path (preferred when set and valid). */
  path?: string;
  /** Remote URL to clone/fetch. */
  remote?: string;
  credential?: GitCredential | null;
  home?: string;
  /** Fetch after open when clone already exists (default true for remote). */
  fetch?: boolean;
};

export type EnsureCodeRepoResult = {
  path: string;
  remote: string | null;
  cloned: boolean;
  fetched: boolean;
};

/**
 * Ensure a local git worktree for a source/code project.
 * - path: use as-is if git worktree
 * - remote: clone into ~/.kanbanly/code-clones/<slug> if missing, else open + optional fetch
 */
export function ensureCodeRepo(
  options: EnsureCodeRepoOptions,
): EnsureCodeRepoResult {
  const home = options.home ?? process.env.HOME ?? homedir();
  const cred = options.credential ?? null;

  if (options.path?.trim()) {
    const p = resolve(options.path.trim());
    if (!existsSync(p)) {
      throw new Error(`Code path does not exist: ${p}`);
    }
    if (!existsSync(join(p, ".git")) && !isGitWorkTree(p)) {
      throw new Error(`Not a git repository: ${p}`);
    }
    let fetched = false;
    if (options.fetch && options.remote?.trim()) {
      fetched = fetchCodeRepo(p, cred);
    }
    return {
      path: p,
      remote: options.remote?.trim() || null,
      cloned: false,
      fetched,
    };
  }

  const remote = options.remote?.trim();
  if (!remote) {
    throw new Error("Provide path or remote for source code binding");
  }

  const root = defaultCodeCloneRoot(home);
  mkdirSync(root, { recursive: true });
  const dest = join(root, slugFromCodeRemote(remote));
  let cloned = false;
  let fetched = false;

  if (!existsSync(join(dest, ".git"))) {
    mkdirSync(join(dest, ".."), { recursive: true });
    const cloneUrl = cred?.token ? embedHttpsCredential(remote, cred) : remote;
    const r = spawnSync("git", ["clone", cloneUrl, dest], {
      encoding: "utf8",
    });
    if (r.status !== 0) {
      const msg = (r.stderr ?? r.stdout ?? "").toString();
      if (/Authentication failed|could not read Username|403|401|Permission denied/i.test(msg)) {
        throw new Error(
          "Clone failed: authentication error. Provide a PAT or unlock SSH agent.",
        );
      }
      if (/not found|Repository not found/i.test(msg)) {
        throw new Error("Clone failed: repository not found or no access.");
      }
      throw new Error(`Clone failed: ${msg.split("\n")[0] || "unknown error"}`);
    }
    cloned = true;
    // Clean origin URL without embedded token
    runGit(dest, ["remote", "set-url", "origin", remote]);
  } else if (options.fetch !== false) {
    fetched = fetchCodeRepo(dest, cred);
  }

  if (cred?.token) {
    try {
      const store = new CredentialStore(defaultCredentialPath(dest));
      store.set(cred);
    } catch {
      /* best-effort */
    }
  }

  return { path: dest, remote, cloned, fetched };
}

/** Fetch origin on an existing code clone (uses askpass when credential set). */
export function fetchCodeRepo(
  repoPath: string,
  credential?: GitCredential | null,
): boolean {
  let cred = credential ?? null;
  if (!cred?.token) {
    try {
      const store = new CredentialStore(defaultCredentialPath(repoPath));
      if (store.has()) cred = store.get();
    } catch {
      /* ignore */
    }
  }
  const env = gitAuthEnv(cred, repoPath);
  const r = runGit(repoPath, ["fetch", "origin", "--prune"], env);
  if (!r.ok) {
    // Non-fatal for local-only remotes
    return false;
  }
  // Prefer fast-forward main/master if possible
  const branch = runGit(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const b = branch.stdout.trim();
  if (b && b !== "HEAD") {
    runGit(repoPath, ["merge", "--ff-only", `origin/${b}`], env);
  }
  return true;
}

/** List commits from a code worktree (product history). */
export function listCodeCommits(
  repoPath: string,
  options?: { limit?: number },
): ProjectCommit[] {
  const limit = options?.limit ?? 50;
  const r = runGit(repoPath, [
    "log",
    `-n${limit}`,
    "--format=%H%x09%aI%x09%an%x09%s",
  ]);
  if (!r.ok && !r.stdout.trim()) {
    throw new Error(r.stderr || "git log failed on code repo");
  }
  return parseGitLogLines(r.stdout);
}

/** True if dir looks like a managed code clone root. */
export function listCodeClones(home = process.env.HOME ?? homedir()): string[] {
  const root = defaultCodeCloneRoot(home);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => join(root, e.name));
}
