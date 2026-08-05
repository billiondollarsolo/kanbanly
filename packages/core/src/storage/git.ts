import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import {
  appendColumn,
  defaultBoardYaml,
  parseBoard,
  removeColumn,
  renameColumn,
  reorderColumns,
  serializeBoard,
  type Board,
  type BoardColumn,
} from "../board.ts";
import { parseCard, serializeCard, type Card } from "../card.ts";
import {
  extractConflictSides,
  hasConflictMarkers,
  healConflict,
  resolveConflictSides,
  resolveConflictText,
  type ConflictResolveChoice,
} from "../heal.ts";
import { cardFilename, generateBoardId, generateCardId } from "../id.ts";
import { orderAfter, orderInitial } from "../order.ts";
import {
  defaultCodeCloneRoot,
  slugFromCodeRemote,
} from "../code-repo.ts";
import {
  boardNotesRelPath,
  defaultProjectNotes,
  mergeCodeBindingSettings,
  parseGitLogLines,
  resolveCodeBinding,
  type CodeBinding,
  type ProjectCommit,
} from "../project-cockpit.ts";
import {
  gitAuthEnv,
  type GitCredential,
} from "./credentials.ts";
import type {
  BoardStorage,
  BoardSummary,
  CardRef,
  StorageResult,
} from "./types.ts";

export type GitStorageOptions = {
  /** Local clone path */
  repoPath: string;
  /** Optional remote URL (for clone/push) */
  remoteUrl?: string;
  /** Max push rebase retries (default 3) */
  maxPushRetries?: number;
  /** Author for commits */
  authorName?: string;
  authorEmail?: string;
  /** Optional HTTPS credential for push/fetch */
  credential?: GitCredential | null;
};

/** Snapshot of a diverged card after a failed rebase (for keep-mine/theirs UI). */
export type ConflictSnapshot = {
  /** Repo-relative path e.g. backend/cards/c-xxx-title.md */
  path: string;
  boardId: string;
  cardId: string;
  title?: string;
  ours: string;
  theirs: string;
  /** Working tree text if markers present */
  conflicted?: string;
};

/** One commit from `git log --follow` on a card path. */
export type CardHistoryEntry = {
  sha: string;
  date: string;
  author: string;
  subject: string;
};

export type ConflictStoreFile = {
  files: ConflictSnapshot[];
  createdAt: string;
  message?: string;
};

function runGit(
  repoPath: string,
  args: string[],
  opts?: { env?: Record<string, string> },
): { ok: boolean; stdout: string; stderr: string; code: number } {
  const res = spawnSync("git", args, {
    cwd: repoPath,
    encoding: "utf8",
    env: { ...process.env, ...opts?.env },
  });
  return {
    ok: res.status === 0,
    stdout: (res.stdout ?? "").toString(),
    stderr: (res.stderr ?? "").toString(),
    code: res.status ?? 1,
  };
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Git-backed board storage. Shells out to real `git` — never mocked in tests.
 */
export class GitStorage implements BoardStorage {
  readonly repoPath: string;
  private remoteUrl?: string;
  private maxPushRetries: number;
  private authorName: string;
  private authorEmail: string;
  private credential: GitCredential | null;

  constructor(options: GitStorageOptions) {
    this.repoPath = options.repoPath;
    this.remoteUrl = options.remoteUrl;
    this.maxPushRetries = options.maxPushRetries ?? 3;
    this.authorName = options.authorName ?? "kanbanly";
    this.authorEmail = options.authorEmail ?? "kanbanly@local";
    this.credential = options.credential ?? null;
  }

  /** Update HTTPS credential used for push/fetch (server re-enter flow). */
  setCredential(cred: GitCredential | null): void {
    this.credential = cred;
  }

  private authEnv(): Record<string, string> | undefined {
    return gitAuthEnv(this.credential, this.repoPath);
  }

  private conflictsPath(): string {
    return join(this.repoPath, ".kanbanly", "conflicts.json");
  }

  /** Initialize a new bare+clone pair or open existing repo. */
  static initLocal(repoPath: string): GitStorage {
    mkdirSync(repoPath, { recursive: true });
    if (!existsSync(join(repoPath, ".git"))) {
      const r = runGit(repoPath, ["init"]);
      if (!r.ok) throw new Error(`git init failed: ${r.stderr}`);
      runGit(repoPath, ["config", "user.name", "kanbanly"]);
      runGit(repoPath, ["config", "user.email", "kanbanly@local"]);
      // Default branch main
      runGit(repoPath, ["checkout", "-b", "main"]);
    }
    return new GitStorage({ repoPath });
  }

  /** Clone a remote into dest, or open if already cloned. */
  static clone(remoteUrl: string, dest: string): GitStorage {
    if (!existsSync(join(dest, ".git"))) {
      // Let git create dest; only ensure parent exists
      mkdirSync(join(dest, ".."), { recursive: true });
      const r = spawnSync("git", ["clone", remoteUrl, dest], { encoding: "utf8" });
      if (r.status !== 0) {
        throw new Error(`git clone failed: ${(r.stderr ?? "").toString()}`);
      }
    }
    return new GitStorage({ repoPath: dest, remoteUrl });
  }

  git(args: string[]): { ok: boolean; stdout: string; stderr: string; code: number } {
    return runGit(this.repoPath, args);
  }

  headSha(): string {
    const r = this.git(["rev-parse", "HEAD"]);
    return r.ok ? r.stdout.trim() : "";
  }

  private boardDir(boardId: string): string {
    // Layout A: boardId is a subdirectory. Layout B: boardId "" or "." means root.
    if (!boardId || boardId === "." || boardId === "/") return this.repoPath;
    return join(this.repoPath, boardId);
  }

  private cardsDir(boardId: string): string {
    return join(this.boardDir(boardId), "cards");
  }

  async listBoards(): Promise<StorageResult<BoardSummary[]>> {
    try {
      const entries = readdirSync(this.repoPath, { withFileTypes: true });
      const boards: BoardSummary[] = [];

      // Layout B: board.yml at root
      if (existsSync(join(this.repoPath, "board.yml"))) {
        boards.push({ id: ".", path: "." });
      }

      // Layout A: subdirs with board.yml
      for (const e of entries) {
        if (!e.isDirectory() || e.name.startsWith(".")) continue;
        if (existsSync(join(this.repoPath, e.name, "board.yml"))) {
          boards.push({ id: e.name, path: e.name });
        }
      }

      return { ok: true, value: boards };
    } catch (cause) {
      return { ok: false, error: { kind: "io", message: String(cause), cause } };
    }
  }

  async readBoard(boardId: string): Promise<StorageResult<Board>> {
    const path = join(this.boardDir(boardId), "board.yml");
    if (!existsSync(path)) {
      return { ok: false, error: { kind: "not_found", path } };
    }
    const text = readFileSync(path, "utf8");
    const parsed = parseBoard(text);
    if (!parsed.ok) {
      return { ok: false, error: { kind: "io", message: parsed.error.message } };
    }
    return { ok: true, value: parsed.board };
  }

  /**
   * Write board.yml and commit. Used for column config changes (add list, etc.).
   */
  async writeBoard(
    boardId: string,
    board: Board,
    options?: { message?: string },
  ): Promise<StorageResult<{ sha?: string }>> {
    try {
      const path = join(this.boardDir(boardId), "board.yml");
      if (!existsSync(dirname(path))) {
        mkdirSync(dirname(path), { recursive: true });
      }
      // Re-validate before write
      const check = parseBoard(serializeBoard(board));
      if (!check.ok) {
        return { ok: false, error: { kind: "io", message: check.error.message } };
      }
      writeFileSync(path, serializeBoard(check.board), "utf8");
      const rel = relative(this.repoPath, path);
      this.git(["add", rel]);
      const msg =
        options?.message ?? `chore(board): update board.yml (${boardId})`;
      const commit = this.git([
        "-c",
        `user.name=${this.authorName}`,
        "-c",
        `user.email=${this.authorEmail}`,
        "commit",
        "-m",
        msg,
      ]);
      if (!commit.ok && !/nothing to commit/i.test(commit.stdout + commit.stderr)) {
        return {
          ok: false,
          error: {
            kind: "io",
            message: `commit failed: ${commit.stderr || commit.stdout}`,
          },
        };
      }
      return { ok: true, value: { sha: this.headSha() } };
    } catch (cause) {
      return { ok: false, error: { kind: "io", message: String(cause), cause } };
    }
  }

  /**
   * Append a column to board.yml (Trello-style "add list") and commit.
   */
  async addColumn(
    boardId: string,
    input: { name: string; id?: string },
    options?: { message?: string },
  ): Promise<StorageResult<{ board: Board; column: BoardColumn; sha?: string }>> {
    const read = await this.readBoard(boardId);
    if (!read.ok) return read;
    const appended = appendColumn(read.value, input);
    if (!appended.ok) {
      return { ok: false, error: { kind: "io", message: appended.error } };
    }
    const w = await this.writeBoard(boardId, appended.board, {
      message:
        options?.message ??
        `chore(board): add column ${appended.column.id} (${appended.column.name})`,
    });
    if (!w.ok) return w;
    return {
      ok: true,
      value: {
        board: appended.board,
        column: appended.column,
        sha: w.value.sha,
      },
    };
  }

  /** Rename column display name in board.yml (id unchanged). */
  async renameColumn(
    boardId: string,
    columnId: string,
    name: string,
    options?: { message?: string },
  ): Promise<StorageResult<{ board: Board; column: BoardColumn; sha?: string }>> {
    const read = await this.readBoard(boardId);
    if (!read.ok) return read;
    const renamed = renameColumn(read.value, columnId, name);
    if (!renamed.ok) {
      return { ok: false, error: { kind: "io", message: renamed.error } };
    }
    const w = await this.writeBoard(boardId, renamed.board, {
      message:
        options?.message ??
        `chore(board): rename column ${columnId} → ${renamed.column.name}`,
    });
    if (!w.ok) return w;
    return {
      ok: true,
      value: {
        board: renamed.board,
        column: renamed.column,
        sha: w.value.sha,
      },
    };
  }

  /** Reorder columns in board.yml to match orderedIds. */
  async reorderColumns(
    boardId: string,
    orderedIds: string[],
    options?: { message?: string },
  ): Promise<StorageResult<{ board: Board; sha?: string }>> {
    const read = await this.readBoard(boardId);
    if (!read.ok) return read;
    const reordered = reorderColumns(read.value, orderedIds);
    if (!reordered.ok) {
      return { ok: false, error: { kind: "io", message: reordered.error } };
    }
    const w = await this.writeBoard(boardId, reordered.board, {
      message: options?.message ?? `chore(board): reorder columns (${boardId})`,
    });
    if (!w.ok) return w;
    return {
      ok: true,
      value: { board: reordered.board, sha: w.value.sha },
    };
  }

  /**
   * Delete a column from board.yml.
   * If cards remain on that column, pass `moveTo` (another column id) or
   * `moveTo: "archive"` to archive them first.
   */
  async deleteColumn(
    boardId: string,
    columnId: string,
    options?: { moveTo?: string; message?: string },
  ): Promise<
    StorageResult<{
      board: Board;
      sha?: string;
      moved?: number;
      archived?: number;
    }>
  > {
    const read = await this.readBoard(boardId);
    if (!read.ok) return read;

    const listed = await this.listCards(boardId);
    if (!listed.ok) return listed;

    const inColumn: string[] = [];
    for (const ref of listed.value) {
      const card = await this.readCard(boardId, ref.id);
      if (card.ok && card.value.frontmatter.column === columnId) {
        inColumn.push(ref.id);
      }
    }

    let moved = 0;
    let archived = 0;
    const moveTo = options?.moveTo?.trim();

    if (inColumn.length > 0) {
      if (!moveTo) {
        return {
          ok: false,
          error: {
            kind: "io",
            message: `Column "${columnId}" has ${inColumn.length} card(s); pass moveTo (column id or "archive")`,
          },
        };
      }
      if (moveTo === "archive") {
        const ar = await this.archiveCards(boardId, inColumn, {
          message: `chore(board): archive before delete column ${columnId}`,
        });
        if (!ar.ok) return ar;
        archived = ar.value.archived.length;
      } else {
        if (!read.value.columns.some((c) => c.id === moveTo)) {
          return {
            ok: false,
            error: { kind: "io", message: `moveTo column not found: ${moveTo}` },
          };
        }
        if (moveTo === columnId) {
          return {
            ok: false,
            error: { kind: "io", message: "moveTo cannot be the column being deleted" },
          };
        }
        // Append to end of target column
        const targetCards: Array<{ order: string }> = [];
        for (const ref of listed.value) {
          if (inColumn.includes(ref.id)) continue;
          const card = await this.readCard(boardId, ref.id);
          if (card.ok && card.value.frontmatter.column === moveTo) {
            targetCards.push({ order: card.value.frontmatter.order });
          }
        }
        targetCards.sort((a, b) =>
          a.order < b.order ? -1 : a.order > b.order ? 1 : 0,
        );
        let lastOrder =
          targetCards.length > 0 ? targetCards[targetCards.length - 1]!.order : null;
        for (const cardId of inColumn) {
          const order = orderAfter(lastOrder) || orderInitial();
          lastOrder = order;
          const mv = await this.moveCard(boardId, cardId, moveTo, order, {
            actor: "human",
            message: `chore(board): move ${cardId} before delete column ${columnId}`,
          });
          if (!mv.ok) return mv;
          moved++;
        }
      }
    }

    // Re-read board after card ops (still same columns until we write)
    const again = await this.readBoard(boardId);
    if (!again.ok) return again;
    const removed = removeColumn(again.value, columnId);
    if (!removed.ok) {
      return { ok: false, error: { kind: "io", message: removed.error } };
    }
    const w = await this.writeBoard(boardId, removed.board, {
      message:
        options?.message ??
        `chore(board): delete column ${columnId}${
          archived ? ` (archived ${archived})` : moved ? ` (moved ${moved})` : ""
        }`,
    });
    if (!w.ok) return w;
    return {
      ok: true,
      value: {
        board: removed.board,
        sha: w.value.sha,
        moved,
        archived,
      },
    };
  }

  /**
   * Create a layout-A board subdirectory with starter board.yml + empty cards/.
   * Id is a unique random `b-…` unless explicitly provided.
   */
  async createBoard(
    input: { name: string; id?: string },
    options?: { message?: string },
  ): Promise<StorageResult<{ boardId: string; sha?: string }>> {
    const name = input.name.trim();
    if (!name) {
      return { ok: false, error: { kind: "io", message: "Board name is required" } };
    }

    const listed = await this.listBoards();
    if (!listed.ok) return listed;
    const existing = new Set(listed.value.map((b) => b.id));

    let id: string;
    if (input.id?.trim()) {
      id = input.id
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, "-")
        .replace(/^-+|-+$/g, "");
      if (!id || id === "." || id === "..") {
        return { ok: false, error: { kind: "io", message: "Invalid board id" } };
      }
      if (id === "cards" || id === "archive" || id.startsWith(".")) {
        return {
          ok: false,
          error: { kind: "io", message: `Reserved board id: ${id}` },
        };
      }
      if (existing.has(id)) {
        return {
          ok: false,
          error: { kind: "io", message: `Board already exists: ${id}` },
        };
      }
    } else {
      id = generateBoardId(existing);
    }

    // If only layout B (root board), still allow layout A siblings.
    try {
      const root = this.boardDir(id);
      if (existsSync(join(root, "board.yml"))) {
        return { ok: false, error: { kind: "io", message: `Board already exists: ${id}` } };
      }
      mkdirSync(join(root, "cards"), { recursive: true });
      const ymlPath = join(root, "board.yml");
      writeFileSync(
        ymlPath,
        defaultBoardYaml({ id, title: name }),
        "utf8",
      );
      // empty cards dir placeholder so git tracks the tree
      const keep = join(root, "cards", ".gitkeep");
      if (!existsSync(keep)) writeFileSync(keep, "", "utf8");

      const relBoard = relative(this.repoPath, ymlPath);
      const relKeep = relative(this.repoPath, keep);
      this.git(["add", relBoard, relKeep]);
      const msg =
        options?.message ?? `chore(board): create board ${id} (${name})`;
      const commit = this.git([
        "-c",
        `user.name=${this.authorName}`,
        "-c",
        `user.email=${this.authorEmail}`,
        "commit",
        "-m",
        msg,
      ]);
      if (!commit.ok && !/nothing to commit/i.test(commit.stdout + commit.stderr)) {
        return {
          ok: false,
          error: {
            kind: "io",
            message: `commit failed: ${commit.stderr || commit.stdout}`,
          },
        };
      }
      return { ok: true, value: { boardId: id, sha: this.headSha() } };
    } catch (cause) {
      return { ok: false, error: { kind: "io", message: String(cause), cause } };
    }
  }

  async listCards(boardId: string): Promise<StorageResult<CardRef[]>> {
    const dir = this.cardsDir(boardId);
    if (!existsSync(dir)) {
      this.invalidateCardPathCache(boardId);
      return { ok: true, value: [] };
    }
    try {
      const files = readdirSync(dir).filter(
        (f) => f.endsWith(".md") && !statSync(join(dir, f)).isDirectory(),
      );
      // Refresh path cache from disk (external commits / other processes)
      const map = new Map<string, string>();
      const refs: CardRef[] = [];
      for (const f of files) {
        const idMatch = f.match(/^(c-[a-z0-9]+)-/i);
        if (!idMatch) continue;
        const abs = join(dir, f);
        map.set(idMatch[1]!, abs);
        refs.push({
          id: idMatch[1]!,
          filename: f,
          path: join(boardId === "." ? "cards" : `${boardId}/cards`, f),
        });
      }
      this.cardPathCache.set(boardId, map);
      return { ok: true, value: refs };
    } catch (cause) {
      return { ok: false, error: { kind: "io", message: String(cause), cause } };
    }
  }

  /** boardId → cardId → absolute path (avoids O(n) readdir per read). */
  private cardPathCache = new Map<string, Map<string, string>>();

  private invalidateCardPathCache(boardId?: string): void {
    if (boardId == null) this.cardPathCache.clear();
    else this.cardPathCache.delete(boardId);
  }

  private cardPathMap(boardId: string): Map<string, string> {
    let map = this.cardPathCache.get(boardId);
    if (map) return map;
    map = new Map();
    const dir = this.cardsDir(boardId);
    if (existsSync(dir)) {
      for (const f of readdirSync(dir)) {
        if (!f.endsWith(".md") || statSync(join(dir, f)).isDirectory()) continue;
        const idMatch = f.match(/^(c-[a-z0-9]+)-/i);
        if (idMatch) map.set(idMatch[1]!, join(dir, f));
      }
    }
    this.cardPathCache.set(boardId, map);
    return map;
  }

  findCardPath(boardId: string, cardId: string): string | null {
    return this.cardPathMap(boardId).get(cardId) ?? null;
  }

  /** Active cards/ or cards/archive/ path for history follow. */
  findCardPathIncludingArchive(boardId: string, cardId: string): string | null {
    const active = this.findCardPath(boardId, cardId);
    if (active) return active;
    const archiveDir = join(this.cardsDir(boardId), "archive");
    if (!existsSync(archiveDir)) return null;
    try {
      for (const f of readdirSync(archiveDir)) {
        if (f.startsWith(`${cardId}-`) && f.endsWith(".md")) {
          return join(archiveDir, f);
        }
      }
    } catch {
      /* ignore */
    }
    return null;
  }

  /**
   * git log --follow for a card (including after archive).
   * Spec US-22: full history survives git mv to cards/archive/.
   */
  cardHistory(
    boardId: string,
    cardId: string,
    options?: { limit?: number },
  ): StorageResult<CardHistoryEntry[]> {
    const path = this.findCardPathIncludingArchive(boardId, cardId);
    if (!path) {
      return { ok: false, error: { kind: "not_found", path: `${boardId}/${cardId}` } };
    }
    const rel = relative(this.repoPath, path).replace(/\\/g, "/");
    const limit = options?.limit ?? 50;
    const r = this.git([
      "log",
      "--follow",
      `-n${limit}`,
      "--format=%H%x09%aI%x09%an%x09%s",
      "--",
      rel,
    ]);
    if (!r.ok && !r.stdout.trim()) {
      return {
        ok: false,
        error: { kind: "io", message: r.stderr || "git log failed" },
      };
    }
    const entries: CardHistoryEntry[] = [];
    for (const line of r.stdout.split("\n")) {
      if (!line.trim()) continue;
      const [sha, date, author, ...rest] = line.split("\t");
      if (!sha) continue;
      entries.push({
        sha,
        date: date ?? "",
        author: author ?? "",
        subject: rest.join("\t"),
      });
    }
    return { ok: true, value: entries };
  }

  /**
   * Project (code) repo commit history for a board with settings.code.path
   * (or a managed clone from settings.code.remote). Does **not** list boards-repo commits.
   */
  codeHistory(
    boardId: string,
    options?: {
      limit?: number;
      /** Optional home for resolving ~/.kanbanly/code-clones */
      home?: string;
      /** When path missing but remote set, open/fetch managed clone if present */
      allowManagedClone?: boolean;
    },
  ): StorageResult<{
    bound: boolean;
    binding: CodeBinding | null;
    commits: ProjectCommit[];
    codePath?: string;
    error?: string;
  }> {
    const board = this.readBoardSync(boardId);
    if (!board.ok) return board;
    const binding = resolveCodeBinding(board.value.settings);
    if (!binding?.path && !binding?.remote) {
      return {
        ok: true,
        value: {
          bound: false,
          binding,
          commits: [],
          error: "No project source bound (settings.code.path or settings.code.remote)",
        },
      };
    }

    let codePath = binding?.path;
    if (
      !codePath &&
      binding?.remote &&
      options?.allowManagedClone !== false
    ) {
      // Resolve managed clone path without re-cloning (read-only probe)
      const home = options?.home ?? process.env.HOME ?? undefined;
      const managed = join(
        defaultCodeCloneRoot(home),
        slugFromCodeRemote(binding.remote),
      );
      if (existsSync(join(managed, ".git"))) {
        codePath = managed;
      }
    }

    if (!codePath) {
      return {
        ok: true,
        value: {
          bound: false,
          binding,
          commits: [],
          error: binding?.remote
            ? "Code remote is set but not cloned yet — use Connect source / code-source API"
            : "No project code path bound (settings.code.path)",
        },
      };
    }

    if (!existsSync(codePath)) {
      return {
        ok: true,
        value: {
          bound: false,
          binding,
          commits: [],
          codePath,
          error: `Code path does not exist: ${codePath}`,
        },
      };
    }
    if (!existsSync(join(codePath, ".git")) && !this.isGitWorkTree(codePath)) {
      return {
        ok: true,
        value: {
          bound: false,
          binding,
          commits: [],
          codePath,
          error: `Not a git repository: ${codePath}`,
        },
      };
    }
    const limit = options?.limit ?? 50;
    const r = runGit(codePath, [
      "log",
      `-n${limit}`,
      "--format=%H%x09%aI%x09%an%x09%s",
    ]);
    if (!r.ok && !r.stdout.trim()) {
      return {
        ok: false,
        error: {
          kind: "io",
          message: r.stderr || "git log failed on code repo",
        },
      };
    }
    return {
      ok: true,
      value: {
        bound: true,
        binding,
        commits: parseGitLogLines(r.stdout),
        codePath,
      },
    };
  }

  /** Persist settings.code path/remote into board.yml and commit. */
  async setCodeBinding(
    boardId: string,
    binding: CodeBinding | null,
  ): Promise<StorageResult<{ board: Board; sha?: string }>> {
    const read = await this.readBoard(boardId);
    if (!read.ok) return read;
    const settings = mergeCodeBindingSettings(read.value.settings, binding);
    const next: Board = {
      ...read.value,
      labels: read.value.labels ?? [],
      settings,
    };
    const w = await this.writeBoard(boardId, next, {
      message: `chore(board): set code binding for ${boardId}`,
    });
    if (!w.ok) return w;
    return { ok: true, value: { board: next, sha: w.value.sha } };
  }

  readNotes(boardId: string): StorageResult<{ body: string; path: string; exists: boolean }> {
    const rel = boardNotesRelPath(boardId);
    const abs = join(this.repoPath, rel);
    if (!existsSync(this.boardDir(boardId))) {
      return { ok: false, error: { kind: "not_found", path: boardId } };
    }
    if (!existsSync(abs)) {
      return {
        ok: true,
        value: { body: "", path: rel, exists: false },
      };
    }
    return {
      ok: true,
      value: { body: readFileSync(abs, "utf8"), path: rel, exists: true },
    };
  }

  async writeNotes(
    boardId: string,
    body: string,
    options?: { message?: string; title?: string },
  ): Promise<StorageResult<{ sha?: string; path: string }>> {
    try {
      const root = this.boardDir(boardId);
      if (!existsSync(root) && boardId !== ".") {
        return { ok: false, error: { kind: "not_found", path: boardId } };
      }
      mkdirSync(root, { recursive: true });
      const rel = boardNotesRelPath(boardId);
      const abs = join(this.repoPath, rel);
      const text =
        body.trim().length > 0
          ? body.endsWith("\n")
            ? body
            : body + "\n"
          : defaultProjectNotes(options?.title);
      writeFileSync(abs, text, "utf8");
      this.git(["add", rel]);
      const msg =
        options?.message ?? `chore(board): update NOTES.md (${boardId})`;
      const commit = this.git([
        "-c",
        `user.name=${this.authorName}`,
        "-c",
        `user.email=${this.authorEmail}`,
        "commit",
        "-m",
        msg,
      ]);
      if (
        !commit.ok &&
        !/nothing to commit/i.test(commit.stdout + commit.stderr)
      ) {
        return {
          ok: false,
          error: {
            kind: "io",
            message: `commit failed: ${commit.stderr || commit.stdout}`,
          },
        };
      }
      return { ok: true, value: { sha: this.headSha(), path: rel } };
    } catch (cause) {
      return { ok: false, error: { kind: "io", message: String(cause), cause } };
    }
  }

  private readBoardSync(boardId: string): StorageResult<Board> {
    const path = join(this.boardDir(boardId), "board.yml");
    if (!existsSync(path)) {
      return { ok: false, error: { kind: "not_found", path } };
    }
    const text = readFileSync(path, "utf8");
    const parsed = parseBoard(text);
    if (!parsed.ok) {
      return { ok: false, error: { kind: "io", message: parsed.error.message } };
    }
    return { ok: true, value: parsed.board };
  }

  private isGitWorkTree(dir: string): boolean {
    const r = runGit(dir, ["rev-parse", "--is-inside-work-tree"]);
    return r.ok && r.stdout.trim() === "true";
  }

  async readCard(boardId: string, cardId: string): Promise<StorageResult<Card>> {
    const path = this.findCardPath(boardId, cardId);
    if (!path) return { ok: false, error: { kind: "not_found", path: cardId } };
    const text = readFileSync(path, "utf8");
    const parsed = parseCard(text);
    if (!parsed.ok) {
      return { ok: false, error: { kind: "io", message: parsed.error.message } };
    }
    return { ok: true, value: parsed.card };
  }

  async writeCard(
    boardId: string,
    card: Card,
    options?: { message?: string },
  ): Promise<StorageResult<{ sha?: string }>> {
    try {
      const dir = this.cardsDir(boardId);
      mkdirSync(dir, { recursive: true });
      const filename = cardFilename(card.frontmatter.id, card.frontmatter.title);
      const abs = join(dir, filename);

      // Remove any previous file with same id but different slug
      if (existsSync(dir)) {
        for (const f of readdirSync(dir)) {
          if (f.startsWith(`${card.frontmatter.id}-`) && f.endsWith(".md") && f !== filename) {
            const old = join(dir, f);
            this.git(["rm", "-f", "--ignore-unmatch", relative(this.repoPath, old)]);
            try {
              const { unlinkSync } = await import("node:fs");
              unlinkSync(old);
            } catch {
              /* ignore */
            }
          }
        }
      }

      writeFileSync(abs, serializeCard(card), "utf8");
      this.invalidateCardPathCache(boardId);
      this.cardPathMap(boardId).set(card.frontmatter.id, abs);
      const rel = relative(this.repoPath, abs);
      this.git(["add", rel]);
      const msg =
        options?.message ??
        `chore(board): update ${card.frontmatter.id} (${card.frontmatter.title})`;
      const commit = this.git([
        "-c",
        `user.name=${this.authorName}`,
        "-c",
        `user.email=${this.authorEmail}`,
        "commit",
        "-m",
        msg,
        "--allow-empty",
      ]);
      if (!commit.ok && !commit.stdout.includes("nothing to commit")) {
        // If nothing changed, still ok
        if (!/nothing to commit|no changes added/i.test(commit.stdout + commit.stderr)) {
          return {
            ok: false,
            error: { kind: "io", message: `commit failed: ${commit.stderr || commit.stdout}` },
          };
        }
      }
      return { ok: true, value: { sha: this.headSha() } };
    } catch (cause) {
      return { ok: false, error: { kind: "io", message: String(cause), cause } };
    }
  }

  async moveCard(
    boardId: string,
    cardId: string,
    toColumn: string,
    newOrder: string,
    options?: { actor?: string; message?: string },
  ): Promise<StorageResult<{ sha?: string }>> {
    const read = await this.readCard(boardId, cardId);
    if (!read.ok) return read;
    const card = read.value;
    const actor = options?.actor ?? "human";
    const from = card.frontmatter.column;
    card.frontmatter.column = toColumn;
    card.frontmatter.order = newOrder;
    card.frontmatter.updated = nowIso();
    card.log.push(`${today()} ${actor}: moved ${from} → ${toColumn}`);
    return this.writeCard(boardId, card, {
      message:
        options?.message ??
        `chore(board): move ${cardId} to ${toColumn}`,
    });
  }

  /**
   * Update card fields (title, status, labels, assignee, due, priority, column, order).
   * Bumps `updated` and appends a Log line. ## Log is not rewritten wholesale from client.
   */
  async updateCard(
    boardId: string,
    cardId: string,
    patch: {
      title?: string;
      status?: string;
      labels?: string[];
      assignee?: string | null;
      due?: string | null;
      priority?: string | null;
      column?: string;
      order?: string;
    },
    options?: { actor?: string; message?: string },
  ): Promise<StorageResult<{ sha?: string; card: Card }>> {
    const read = await this.readCard(boardId, cardId);
    if (!read.ok) return read;
    const card = read.value;
    const actor = options?.actor ?? "human";
    const changes: string[] = [];

    if (patch.title !== undefined && patch.title !== card.frontmatter.title) {
      card.frontmatter.title = patch.title;
      changes.push("title");
    }
    if (patch.column !== undefined && patch.column !== card.frontmatter.column) {
      changes.push(`column→${patch.column}`);
      card.frontmatter.column = patch.column;
    }
    if (patch.order !== undefined) card.frontmatter.order = patch.order;
    if (patch.labels !== undefined) {
      card.frontmatter.labels = patch.labels;
      changes.push("labels");
    }
    if (patch.assignee !== undefined) {
      card.frontmatter.assignee = patch.assignee === null ? undefined : patch.assignee;
      changes.push("assignee");
    }
    if (patch.due !== undefined) {
      card.frontmatter.due = patch.due === null ? undefined : patch.due;
      changes.push("due");
    }
    if (patch.priority !== undefined) {
      card.frontmatter.priority = patch.priority === null ? undefined : patch.priority;
      changes.push("priority");
    }
    if (patch.status !== undefined && patch.status !== card.status) {
      card.status = patch.status;
      changes.push("status");
    }

    card.frontmatter.updated = nowIso();
    if (changes.length > 0) {
      card.log.push(`${today()} ${actor}: updated ${changes.join(", ")}`);
    }

    const w = await this.writeCard(boardId, card, {
      message:
        options?.message ??
        `chore(board): update ${cardId}${changes.length ? ` (${changes.join(", ")})` : ""}`,
    });
    if (!w.ok) return w;
    return { ok: true, value: { sha: w.value.sha, card } };
  }

  /**
   * Archive cards by git mv into cards/archive/. Single commit.
   * Returns archived ids. Skipped by listCards (archive is a subdirectory).
   */
  async archiveCards(
    boardId: string,
    cardIds: string[],
    options?: { message?: string },
  ): Promise<StorageResult<{ sha?: string; archived: string[] }>> {
    try {
      const cardsDir = this.cardsDir(boardId);
      const archiveDir = join(cardsDir, "archive");
      mkdirSync(archiveDir, { recursive: true });
      const archived: string[] = [];

      for (const cardId of cardIds) {
        const path = this.findCardPath(boardId, cardId);
        if (!path) continue;
        const base = path.split("/").pop()!;
        const dest = join(archiveDir, base);
        const relFrom = relative(this.repoPath, path);
        const relTo = relative(this.repoPath, dest);
        const mv = this.git(["mv", relFrom, relTo]);
        if (!mv.ok) {
          // Fallback: rename + git add/rm
          const { renameSync } = await import("node:fs");
          renameSync(path, dest);
          this.git(["add", relTo]);
          this.git(["rm", "-f", "--ignore-unmatch", relFrom]);
        }
        archived.push(cardId);
      }

      if (archived.length === 0) {
        return { ok: false, error: { kind: "not_found", path: cardIds.join(",") } };
      }

      this.invalidateCardPathCache(boardId);

      const msg =
        options?.message ??
        `chore(board): archive ${archived.length} card${archived.length === 1 ? "" : "s"}`;
      const commit = this.git([
        "-c",
        `user.name=${this.authorName}`,
        "-c",
        `user.email=${this.authorEmail}`,
        "commit",
        "-m",
        msg,
      ]);
      if (!commit.ok && !/nothing to commit/i.test(commit.stdout + commit.stderr)) {
        return {
          ok: false,
          error: { kind: "io", message: `commit failed: ${commit.stderr || commit.stdout}` },
        };
      }
      return { ok: true, value: { sha: this.headSha(), archived } };
    } catch (cause) {
      return { ok: false, error: { kind: "io", message: String(cause), cause } };
    }
  }

  /**
   * Create a title-only card in a column, order after last.
   */
  async createCard(
    boardId: string,
    title: string,
    column: string,
    order: string,
    options?: { actor?: string },
  ): Promise<StorageResult<{ card: Card; sha?: string }>> {
    const listed = await this.listCards(boardId);
    const existingIds = listed.ok ? listed.value.map((c) => c.id) : [];
    const id = generateCardId(existingIds);
    const actor = options?.actor ?? "human";
    const card: Card = {
      frontmatter: {
        id,
        title,
        column,
        order,
        updated: nowIso(),
        labels: [],
      },
      status: "_Not started._",
      log: [`${today()} ${actor}: created`],
    };
    const w = await this.writeCard(boardId, card, {
      message: `chore(board): create ${id} (${title})`,
    });
    if (!w.ok) return w;
    return { ok: true, value: { card, sha: w.value.sha } };
  }

  private currentBranch(): string {
    const r = this.git(["rev-parse", "--abbrev-ref", "HEAD"]);
    const name = r.ok ? r.stdout.trim() : "";
    return name && name !== "HEAD" ? name : "main";
  }

  /** Collect paths involved in a failed rebase/merge from status + stderr. */
  private divergedFiles(pullOutput: string): string[] {
    const fromStatus = this.git(["status", "--porcelain"])
      .stdout.split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => l.replace(/^..\s+/, "").replace(/^"+|"+$/g, ""));
    const fromLog: string[] = [];
    for (const line of pullOutput.split("\n")) {
      const m =
        line.match(/CONFLICT\s*(?:\([^)]*\))?\s*:\s*(?:Merge conflict in\s+)?(.+)$/i) ??
        line.match(/both modified:\s*(.+)$/i) ??
        line.match(/Auto-merging\s+(.+)$/i);
      if (m?.[1]) fromLog.push(m[1].trim());
    }
    // Last-resort: card markdown paths mentioned in the rebase output
    const mdPaths = [...pullOutput.matchAll(/(?:^|[\s'"])([\w./-]*cards\/[\w./-]+\.md)/g)].map(
      (m) => m[1]!,
    );
    return [
      ...new Set([...fromStatus, ...fromLog, ...mdPaths].filter((f) => f.length > 0)),
    ];
  }

  private parseCardPath(relPath: string): { boardId: string; cardId: string } | null {
    const normalized = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
    // boardId/cards/c-xxx-title.md or cards/c-xxx-title.md
    const m = normalized.match(/^(?:([^/]+)\/)?cards\/(c-[a-z0-9]+)-[^/]+\.md$/i);
    if (!m) return null;
    return { boardId: m[1] || ".", cardId: m[2]! };
  }

  /** Capture ours/theirs for conflicted paths (stage 2/3) before aborting rebase. */
  private captureConflictSnapshots(files: string[], message?: string): ConflictSnapshot[] {
    const snaps: ConflictSnapshot[] = [];
    for (const f of files) {
      const parsed = this.parseCardPath(f);
      if (!parsed) continue;
      // Git stages: :2: = "ours", :3: = "theirs".
      // During *rebase* (our push path), "ours" is upstream and "theirs" is the
      // local commit being applied — swap so product keep-mine = local work.
      const inRebase =
        existsSync(join(this.repoPath, ".git", "rebase-merge")) ||
        existsSync(join(this.repoPath, ".git", "rebase-apply"));
      const stageLocal = inRebase ? ":3:" : ":2:";
      const stageRemote = inRebase ? ":2:" : ":3:";
      const localR = this.git(["show", `${stageLocal}${f}`]);
      const remoteR = this.git(["show", `${stageRemote}${f}`]);
      let ours = localR.ok ? localR.stdout : "";
      let theirs = remoteR.ok ? remoteR.stdout : "";
      const abs = join(this.repoPath, f);
      let conflicted: string | undefined;
      if (existsSync(abs)) {
        conflicted = readFileSync(abs, "utf8");
        if (hasConflictMarkers(conflicted) && (!ours || !theirs)) {
          const sides = extractConflictSides(conflicted);
          if (sides) {
            // Marker "ours" is HEAD side; during rebase HEAD is upstream — swap
            if (inRebase) {
              ours = ours || sides.theirs;
              theirs = theirs || sides.ours;
            } else {
              ours = ours || sides.ours;
              theirs = theirs || sides.theirs;
            }
          }
        }
      }
      if (!ours && !theirs) continue;
      let title: string | undefined;
      const p = parseCard(ours || theirs);
      if (p.ok) title = p.card.frontmatter.title;
      snaps.push({
        path: f,
        boardId: parsed.boardId,
        cardId: parsed.cardId,
        title,
        ours,
        theirs,
        conflicted,
      });
    }
    this.saveConflicts(snaps, message);
    return snaps;
  }

  private saveConflicts(files: ConflictSnapshot[], message?: string): void {
    const path = this.conflictsPath();
    mkdirSync(dirname(path), { recursive: true });
    const data: ConflictStoreFile = {
      files,
      createdAt: new Date().toISOString(),
      message,
    };
    writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf8");
  }

  listConflicts(): ConflictSnapshot[] {
    try {
      const path = this.conflictsPath();
      if (!existsSync(path)) {
        // Also scan working tree for leftover conflict markers
        return this.scanMarkerConflicts();
      }
      const raw = JSON.parse(readFileSync(path, "utf8")) as ConflictStoreFile;
      return raw.files ?? [];
    } catch {
      return this.scanMarkerConflicts();
    }
  }

  private scanMarkerConflicts(): ConflictSnapshot[] {
    const snaps: ConflictSnapshot[] = [];
    const boards = (() => {
      try {
        // sync list via filesystem
        const out: string[] = [];
        if (existsSync(join(this.repoPath, "board.yml"))) out.push(".");
        for (const e of readdirSync(this.repoPath, { withFileTypes: true })) {
          if (e.isDirectory() && !e.name.startsWith(".") &&
              existsSync(join(this.repoPath, e.name, "board.yml"))) {
            out.push(e.name);
          }
        }
        return out;
      } catch {
        return [] as string[];
      }
    })();
    for (const boardId of boards) {
      const dir = this.cardsDir(boardId);
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir)) {
        if (!f.endsWith(".md")) continue;
        const abs = join(dir, f);
        if (!statSync(abs).isFile()) continue;
        const text = readFileSync(abs, "utf8");
        if (!hasConflictMarkers(text)) continue;
        const idMatch = f.match(/^(c-[a-z0-9]+)-/i);
        if (!idMatch) continue;
        const sides = extractConflictSides(text);
        if (!sides) continue;
        let title: string | undefined;
        const p = parseCard(sides.ours || sides.theirs);
        if (p.ok) title = p.card.frontmatter.title;
        snaps.push({
          path: relative(this.repoPath, abs),
          boardId,
          cardId: idMatch[1]!,
          title,
          ours: sides.ours,
          theirs: sides.theirs,
          conflicted: text,
        });
      }
    }
    return snaps;
  }

  clearConflicts(): void {
    try {
      const path = this.conflictsPath();
      if (existsSync(path)) unlinkSync(path);
    } catch {
      /* ignore */
    }
  }

  /**
   * Apply keep-mine / keep-theirs / heal for a diverged card, commit result.
   */
  async resolveConflict(
    boardId: string,
    cardId: string,
    choice: ConflictResolveChoice,
    options?: { actor?: string },
  ): Promise<StorageResult<{ sha?: string; cardId: string; choice: ConflictResolveChoice }>> {
    const conflicts = this.listConflicts();
    const snap =
      conflicts.find((c) => c.cardId === cardId && c.boardId === boardId) ??
      conflicts.find((c) => c.cardId === cardId);
    const targetBoard = snap?.boardId ?? boardId;
    let resolvedText: string;

    if (snap) {
      // Prefer stored sides (already mapped to product keep-mine / keep-theirs).
      // Do not re-parse conflicted markers — during rebase marker "ours" is upstream.
      if (snap.ours || snap.theirs) {
        resolvedText = resolveConflictSides(snap.ours, snap.theirs, choice);
      } else if (snap.conflicted && hasConflictMarkers(snap.conflicted)) {
        resolvedText = resolveConflictText(snap.conflicted, choice);
      } else {
        resolvedText = snap.ours || snap.theirs || "";
      }
    } else {
      const path = this.findCardPath(targetBoard, cardId);
      if (!path) {
        return { ok: false, error: { kind: "not_found", path: `${targetBoard}/${cardId}` } };
      }
      const text = readFileSync(path, "utf8");
      if (!hasConflictMarkers(text)) {
        return {
          ok: false,
          error: {
            kind: "io",
            message: `No conflict snapshot or markers for ${cardId}`,
          },
        };
      }
      resolvedText = resolveConflictText(text, choice);
    }

    let card: Card;
    const parsed = parseCard(resolvedText);
    if (parsed.ok) {
      card = parsed.card;
    } else {
      const healed = resolveConflictSides(
        snap?.ours ?? resolvedText,
        snap?.theirs ?? resolvedText,
        "heal",
      );
      const p2 = parseCard(healed);
      if (!p2.ok) {
        return {
          ok: false,
          error: {
            kind: "io",
            message: `Resolved text not a valid card: ${parsed.error.message}`,
          },
        };
      }
      card = p2.card;
    }

    const actor = options?.actor ?? "human";
    card.frontmatter.updated = nowIso();
    card.log.push(`${today()} ${actor}: conflict resolved (${choice})`);

    const w = await this.writeCard(targetBoard, card, {
      message: `chore(board): resolve conflict ${cardId} (${choice})`,
    });
    if (!w.ok) return w;

    this.removeConflictSnapshot(cardId);
    return { ok: true, value: { sha: w.value.sha, cardId, choice } };
  }

  private removeConflictSnapshot(cardId: string): void {
    const remaining = this.listConflicts().filter((c) => c.cardId !== cardId);
    if (remaining.length === 0) this.clearConflicts();
    else this.saveConflicts(remaining);
  }

  /**
   * Push with pull --rebase retry up to maxPushRetries.
   * Returns typed conflict error after exhausting retries (or on unresolvable rebase),
   * naming diverged files when known. Captures keep-mine/theirs snapshots.
   */
  async push(): Promise<StorageResult<{ sha: string }>> {
    // Ensure remote exists
    const remotes = this.git(["remote"]);
    if (!remotes.stdout.includes("origin") && this.remoteUrl) {
      this.git(["remote", "add", "origin", this.remoteUrl]);
    }

    const branch = this.currentBranch();
    let lastErr = "";
    let lastFiles: string[] | undefined;
    const auth = this.authEnv();

    for (let attempt = 0; attempt <= this.maxPushRetries; attempt++) {
      const push = runGit(
        this.repoPath,
        ["push", "-u", "origin", `HEAD:refs/heads/${branch}`],
        { env: auth },
      );
      if (push.ok) {
        this.clearConflicts();
        return { ok: true, value: { sha: this.headSha() } };
      }
      lastErr = push.stderr || push.stdout;

      // Non-fast-forward → pull --rebase and retry
      if (
        /non-fast-forward|fetch first|rejected|\[rejected\]|behind/i.test(lastErr) &&
        attempt < this.maxPushRetries
      ) {
        // Fetch first so origin/<branch> is available, then rebase onto it
        runGit(this.repoPath, ["fetch", "origin", branch], { env: auth });
        const pull = this.git(["pull", "--rebase", "origin", branch]);
        if (!pull.ok) {
          const out = `${pull.stderr}\n${pull.stdout}`;
          const files = this.divergedFiles(out);
          lastFiles = files;
          this.captureConflictSnapshots(
            files,
            pull.stderr || pull.stdout,
          );
          // Try abort rebase to leave repo usable
          this.git(["rebase", "--abort"]);
          return {
            ok: false,
            error: {
              kind: "conflict",
              message: `Push failed after rebase: ${pull.stderr || pull.stdout}`,
              files,
            },
          };
        }
        continue;
      }

      if (attempt >= this.maxPushRetries) break;
    }

    return {
      ok: false,
      error: {
        kind: "conflict",
        message: `Push failed after ${this.maxPushRetries} retries: ${lastErr}`,
        files: lastFiles,
      },
    };
  }

  /**
   * Fetch origin and fast-forward when possible. Heals conflict markers after.
   * Used by POST /api/sync/pull (manual "Fetch remote").
   */
  async pullRemote(): Promise<
    StorageResult<{
      sha: string;
      fetched: boolean;
      fastForwarded: boolean;
      healed: string[];
    }>
  > {
    try {
      const remotes = this.git(["remote"]);
      if (!remotes.ok || !remotes.stdout.includes("origin")) {
        return {
          ok: false,
          error: { kind: "io", message: "No origin remote configured" },
        };
      }
      const auth = this.authEnv();
      const branch = this.currentBranch();
      const fetch = runGit(this.repoPath, ["fetch", "origin", "--prune"], {
        env: auth,
      });
      if (!fetch.ok) {
        return {
          ok: false,
          error: {
            kind: "io",
            message: fetch.stderr || fetch.stdout || "git fetch failed",
          },
        };
      }
      let fastForwarded = false;
      const merge = this.git(["merge", "--ff-only", `origin/${branch}`]);
      if (merge.ok) {
        fastForwarded = !/Already up to date|already up to date/i.test(
          merge.stdout + merge.stderr,
        );
      }
      const healed = await this.healWorkingTree();
      const healedPaths = healed.ok ? healed.value.healed : [];
      return {
        ok: true,
        value: {
          sha: this.headSha(),
          fetched: true,
          fastForwarded,
          healed: healedPaths,
        },
      };
    } catch (cause) {
      return { ok: false, error: { kind: "io", message: String(cause), cause } };
    }
  }

  /**
   * Scan working tree for conflict-markered card files and heal them (FR-7).
   * Commits as a single chore(board): heal conflicts when any file changes.
   */
  async healWorkingTree(options?: {
    actor?: string;
  }): Promise<StorageResult<{ healed: string[]; sha?: string }>> {
    const healed: string[] = [];
    try {
      const boards = await this.listBoards();
      if (!boards.ok) return boards;
      for (const b of boards.value) {
        const listed = await this.listCards(b.id);
        if (!listed.ok) continue;
        for (const ref of listed.value) {
          const abs = this.findCardPath(b.id, ref.id);
          if (!abs || !existsSync(abs)) continue;
          const text = readFileSync(abs, "utf8");
          if (!hasConflictMarkers(text)) continue;
          const healedText = healConflict(text);
          if (healedText === text) continue;
          writeFileSync(abs, healedText, "utf8");
          const rel = relative(this.repoPath, abs);
          this.git(["add", rel]);
          healed.push(rel.replace(/\\/g, "/"));
        }
      }
      if (healed.length === 0) {
        return { ok: true, value: { healed: [] } };
      }
      const msg = `chore(board): heal ${healed.length} conflict-markered card${healed.length === 1 ? "" : "s"}`;
      const commit = this.git([
        "-c",
        `user.name=${this.authorName}`,
        "-c",
        `user.email=${this.authorEmail}`,
        "commit",
        "-m",
        msg,
      ]);
      if (!commit.ok && !/nothing to commit/i.test(commit.stdout + commit.stderr)) {
        return {
          ok: false,
          error: { kind: "io", message: `heal commit failed: ${commit.stderr || commit.stdout}` },
        };
      }
      return { ok: true, value: { healed, sha: this.headSha() } };
    } catch (cause) {
      return { ok: false, error: { kind: "io", message: String(cause), cause } };
    }
  }
}
