import { resolve, join } from "node:path";
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readdirSync,
} from "node:fs";
import { homedir } from "node:os";
import {
  CredentialStore,
  defaultBoardYaml,
  defaultCredentialPath,
  GitStorage,
  boardsAgentsMd,
  type GitCredential,
} from "@kanbanly/core";
import { BoardIndexStore, type RemoteIndex } from "./index-store.ts";

export type ConnectedRepo = {
  /** Absolute path to the local boards repo. */
  path: string;
  /** Key used in the index store (absolute path). */
  remoteKey: string;
  storage: GitStorage;
  index: RemoteIndex;
  /** Original remote URL when cloned. */
  remoteUrl?: string;
};

/** Shared process-wide index store (tests may construct their own). */
export const globalIndexStore = new BoardIndexStore();

export type ConnectOptions = {
  indexStore?: BoardIndexStore;
  /** HTTPS credential for clone/push */
  credential?: GitCredential | null;
  /** When true (default), scaffold board.yml if missing */
  scaffold?: boolean;
  /** Layout A board id when scaffolding (default "backend") */
  board?: string;
  /**
   * Clone destination. Defaults to ~/.kanbanly/clones/<slug>.
   * For local path connect, ignored.
   */
  cloneDir?: string;
};

function slugFromRemote(url: string): string {
  const cleaned = url
    .replace(/\.git$/, "")
    .replace(/\/+$/, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const parts = cleaned.split("-").filter(Boolean);
  return (parts.slice(-3).join("-") || "boards").slice(0, 64);
}

export function defaultCloneRoot(): string {
  return join(homedir(), ".kanbanly", "clones");
}

/**
 * Open a local boards git repo, build/refresh the in-memory index, and return
 * the connected handle. Supports layout A (subdir per board with board.yml).
 */
export async function connectLocalRepo(
  repoPath: string,
  options?: ConnectOptions,
): Promise<ConnectedRepo> {
  const path = resolve(repoPath);
  if (!existsSync(path)) {
    throw new Error(`Repo path does not exist: ${path}`);
  }
  if (!existsSync(resolve(path, ".git"))) {
    throw new Error(`Not a git repository (missing .git): ${path}`);
  }

  const storage = new GitStorage({
    repoPath: path,
    authorName: "kanbanly",
    authorEmail: "kanbanly@local",
    credential: options?.credential ?? null,
  });

  if (options?.scaffold !== false) {
    ensureBoardScaffold(path, options?.board);
  }

  // Persist credential if provided
  if (options?.credential?.token) {
    const store = new CredentialStore(defaultCredentialPath(path));
    store.set(options.credential);
    storage.setCredential(options.credential);
  } else {
    const store = new CredentialStore(defaultCredentialPath(path));
    if (store.has()) storage.setCredential(store.get());
  }

  const indexStore = options?.indexStore ?? globalIndexStore;
  const remoteKey = path;
  const { index } = await indexStore.ensure(remoteKey, storage);

  return { path, remoteKey, storage, index };
}

/**
 * Clone a remote boards repo (or reopen existing clone) and connect.
 */
export async function connectRemoteRepo(
  remoteUrl: string,
  options?: ConnectOptions,
): Promise<ConnectedRepo> {
  const url = remoteUrl.trim();
  if (!url) throw new Error("Remote URL is required");

  const root = options?.cloneDir ?? defaultCloneRoot();
  mkdirSync(root, { recursive: true });
  const dest = join(root, slugFromRemote(url));

  // Clone uses credential via URL rewrite for HTTPS when token provided
  let cloneUrl = url;
  if (options?.credential?.token && /^https?:\/\//i.test(url)) {
    try {
      const u = new URL(url);
      u.username = options.credential.username || "x-access-token";
      u.password = options.credential.token;
      cloneUrl = u.toString();
    } catch {
      /* use raw */
    }
  }

  let storage: GitStorage;
  try {
    storage = GitStorage.clone(cloneUrl, dest);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Friendly errors — no stack traces to the client
    if (/Authentication failed|could not read Username|403|401|Permission denied/i.test(msg)) {
      throw new Error(
        "Clone failed: authentication error. Check SSH agent or provide a PAT.",
      );
    }
    if (/not found|does not exist|Repository not found/i.test(msg)) {
      throw new Error("Clone failed: repository not found or no access.");
    }
    if (/Could not resolve host|network|timed out|Failed to connect/i.test(msg)) {
      throw new Error("Clone failed: network error reaching the remote.");
    }
    throw new Error(`Clone failed: ${msg.split("\n")[0]}`);
  }

  storage = new GitStorage({
    repoPath: dest,
    remoteUrl: url,
    authorName: "kanbanly",
    authorEmail: "kanbanly@local",
    credential: options?.credential ?? null,
  });

  // Ensure origin points at clean URL (without embedded token)
  const remotes = storage.git(["remote"]);
  if (!remotes.stdout.includes("origin")) {
    storage.git(["remote", "add", "origin", url]);
  } else {
    storage.git(["remote", "set-url", "origin", url]);
  }

  if (options?.scaffold !== false) {
    ensureBoardScaffold(dest, options?.board);
    // Commit scaffold if we created files
    storage.git(["add", "."]);
    storage.git([
      "-c",
      "user.name=kanbanly",
      "-c",
      "user.email=kanbanly@local",
      "commit",
      "-m",
      "chore(board): scaffold starter board",
      "--allow-empty",
    ]);
  }

  if (options?.credential?.token) {
    const store = new CredentialStore(defaultCredentialPath(dest));
    store.set(options.credential);
    storage.setCredential(options.credential);
  }

  const indexStore = options?.indexStore ?? globalIndexStore;
  const { index } = await indexStore.ensure(dest, storage);

  return {
    path: dest,
    remoteKey: dest,
    storage,
    index,
    remoteUrl: url,
  };
}

/**
 * Ensure at least one board.yml exists. Layout A: board/board.yml.
 */
export function ensureBoardScaffold(
  repoPath: string,
  boardId = "backend",
): { created: boolean; boardPath: string } {
  // Already has board at root (layout B)
  if (existsSync(join(repoPath, "board.yml"))) {
    return { created: false, boardPath: join(repoPath, "board.yml") };
  }
  // Any layout A board?
  try {
    for (const e of readdirSync(repoPath, { withFileTypes: true })) {
      if (
        e.isDirectory() &&
        !e.name.startsWith(".") &&
        existsSync(join(repoPath, e.name, "board.yml"))
      ) {
        return {
          created: false,
          boardPath: join(repoPath, e.name, "board.yml"),
        };
      }
    }
  } catch {
    /* empty */
  }

  const boardRoot = join(repoPath, boardId);
  mkdirSync(join(boardRoot, "cards"), { recursive: true });
  const boardPath = join(boardRoot, "board.yml");
  writeFileSync(boardPath, defaultBoardYaml(), "utf8");
  const agents = join(repoPath, "AGENTS.md");
  if (!existsSync(agents)) {
    writeFileSync(agents, boardsAgentsMd(), "utf8");
  }
  const ga = join(repoPath, ".gitattributes");
  if (!existsSync(ga)) {
    writeFileSync(ga, "**/cards/*.md merge=kanbanly\n", "utf8");
  }
  return { created: true, boardPath };
}

/**
 * Refresh the index for an already-connected repo (after writes or fetch).
 */
export async function refreshRepo(
  connected: ConnectedRepo,
  options?: { indexStore?: BoardIndexStore; force?: boolean },
): Promise<RemoteIndex> {
  const indexStore = options?.indexStore ?? globalIndexStore;
  if (options?.force) {
    return indexStore.rebuild(connected.remoteKey, connected.storage);
  }
  const { index } = await indexStore.ensure(connected.remoteKey, connected.storage);
  connected.index = index;
  return index;
}
