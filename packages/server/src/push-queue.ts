import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  classifyPushError,
  type ClassifiedPushError,
  type PushErrorKind,
} from "@kanbanly/core";
import type { GitStorage } from "@kanbanly/core";

export type SyncStatus =
  | "synced"
  | "pending"
  | "syncing"
  | "error"
  | "no_remote"
  | "offline"
  | "frozen";

export type SyncState = {
  status: SyncStatus;
  /** Local commits waiting to push (coalesced counter). */
  pendingCount: number;
  lastError?: string;
  lastPushedSha?: string;
  lastAttemptAt?: string;
  /** Classified error for banners (§5.3). */
  errorKind?: PushErrorKind;
  errorTitle?: string;
  errorDetail?: string;
  /** True after unresolvable conflict — no auto push until clearFreeze/retry. */
  frozen?: boolean;
  /** Diverged paths from last conflict (for keep-mine UI). */
  conflictFiles?: string[];
  /** Human-readable header line. */
  label: string;
};

export type PushQueueOptions = {
  storage: GitStorage;
  /** Path to queue.json for persistence (survives restart). */
  queuePath: string;
  /** Debounce ms before flush (default 2000). */
  debounceMs?: number;
  /** Called when status changes (for SSE / tests). */
  onChange?: (state: SyncState) => void;
};

type PersistedQueue = {
  pendingCount: number;
  lastError?: string;
  lastPushedSha?: string;
  errorKind?: PushErrorKind;
  errorTitle?: string;
  errorDetail?: string;
  frozen?: boolean;
  conflictFiles?: string[];
};

/**
 * Debounced background push queue.
 * Local commits complete before the API returns; pushes coalesce with ~2s debounce.
 */
export class PushQueue {
  private storage: GitStorage;
  private queuePath: string;
  private debounceMs: number;
  private onChange?: (state: SyncState) => void;
  private pendingCount = 0;
  private status: SyncStatus = "synced";
  private lastError?: string;
  private lastPushedSha?: string;
  private lastAttemptAt?: string;
  private errorKind?: PushErrorKind;
  private errorTitle?: string;
  private errorDetail?: string;
  private frozen = false;
  private conflictFiles?: string[];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushing = false;
  /** Test counter */
  flushCount = 0;

  constructor(options: PushQueueOptions) {
    this.storage = options.storage;
    this.queuePath = options.queuePath;
    this.debounceMs = options.debounceMs ?? 2000;
    this.onChange = options.onChange;
    this.load();
  }

  hasOrigin(): boolean {
    const r = this.storage.git(["remote"]);
    return r.ok && r.stdout.includes("origin");
  }

  getState(): SyncState {
    let status = this.status;
    if (this.frozen) {
      status = "frozen";
    } else if (!this.hasOrigin()) {
      if (this.status === "error" || this.status === "offline") status = this.status;
      else if (this.pendingCount > 0) status = "pending";
      else status = "no_remote";
    } else if (this.flushing || this.status === "syncing") {
      status = "syncing";
    } else if (this.status === "offline") {
      status = "offline";
    } else if (this.status === "error") {
      status = "error";
    } else if (this.pendingCount > 0) {
      status = "pending";
    } else {
      status = "synced";
    }

    return {
      status,
      pendingCount: this.pendingCount,
      lastError: this.lastError,
      lastPushedSha: this.lastPushedSha,
      lastAttemptAt: this.lastAttemptAt,
      errorKind: this.errorKind,
      errorTitle: this.errorTitle,
      errorDetail: this.errorDetail,
      frozen: this.frozen,
      conflictFiles: this.conflictFiles,
      label: labelFor(status, this.pendingCount),
    };
  }

  private emit(): void {
    this.persist();
    this.onChange?.(this.getState());
  }

  private load(): void {
    try {
      if (!existsSync(this.queuePath)) return;
      const raw = JSON.parse(readFileSync(this.queuePath, "utf8")) as PersistedQueue;
      this.pendingCount = Math.max(0, Number(raw.pendingCount) || 0);
      this.lastError = raw.lastError;
      this.lastPushedSha = raw.lastPushedSha;
      this.errorKind = raw.errorKind;
      this.errorTitle = raw.errorTitle;
      this.errorDetail = raw.errorDetail;
      this.frozen = !!raw.frozen;
      this.conflictFiles = raw.conflictFiles;
      if (this.frozen) this.status = "frozen";
      else if (this.errorKind === "offline") this.status = "offline";
      else if (this.lastError && this.pendingCount > 0) this.status = "error";
      else if (this.pendingCount > 0) this.status = "pending";
      else this.status = "synced";
    } catch {
      /* ignore corrupt queue */
    }
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.queuePath), { recursive: true });
      const data: PersistedQueue = {
        pendingCount: this.pendingCount,
        lastError: this.lastError,
        lastPushedSha: this.lastPushedSha,
        errorKind: this.errorKind,
        errorTitle: this.errorTitle,
        errorDetail: this.errorDetail,
        frozen: this.frozen,
        conflictFiles: this.conflictFiles,
      };
      writeFileSync(this.queuePath, JSON.stringify(data, null, 2) + "\n", "utf8");
    } catch {
      /* non-fatal */
    }
  }

  private applyClassified(
    c: ClassifiedPushError,
    rawMessage: string,
    files?: string[],
  ): void {
    this.lastError = rawMessage;
    this.errorKind = c.kind;
    this.errorTitle = c.title;
    this.errorDetail = c.detail;
    if (c.kind === "conflict" && files?.length) {
      this.conflictFiles = files;
    }
    if (c.freezeSync) {
      this.frozen = true;
      this.status = "frozen";
    } else if (c.kind === "offline") {
      this.status = "offline";
    } else {
      this.status = "error";
    }
  }

  /**
   * Call after a successful local commit. Coalesces rapid enqueues into one push.
   * Still works when frozen/offline — local commits always ok.
   */
  enqueue(_localSha?: string): void {
    this.pendingCount += 1;
    // Don't clear freeze on enqueue — user must resolve conflict explicitly
    if (!this.frozen) {
      this.lastError = undefined;
      this.errorKind = undefined;
      this.errorTitle = undefined;
      this.errorDetail = undefined;
      this.status = "pending";
    }
    this.emit();
    if (this.hasOrigin() && !this.frozen) {
      this.schedule();
    }
  }

  private schedule(): void {
    if (this.frozen) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.debounceMs);
    if (typeof this.timer === "object" && this.timer && "unref" in this.timer) {
      (this.timer as NodeJS.Timeout).unref?.();
    }
  }

  /** Clear freeze after user resolved conflicts (keep-mine/theirs). */
  clearFreeze(): void {
    this.frozen = false;
    if (this.errorKind === "conflict") {
      this.errorKind = undefined;
      this.errorTitle = undefined;
      this.errorDetail = undefined;
      this.lastError = undefined;
      this.conflictFiles = undefined;
    }
    this.status = this.pendingCount > 0 ? "pending" : "synced";
    this.emit();
    if (this.pendingCount > 0 && this.hasOrigin()) this.schedule();
  }

  /** After resolving all diverged cards — unfreeze and schedule push. */
  markConflictsResolved(): void {
    this.conflictFiles = undefined;
    this.clearFreeze();
  }

  /** Immediate push attempt (retry banner / tests). Unfreezes only on success. */
  async flush(): Promise<SyncState> {
    if (this.flushing) return this.getState();

    if (!this.hasOrigin()) {
      this.status = this.pendingCount > 0 ? "pending" : "synced";
      this.emit();
      return this.getState();
    }

    if (this.frozen) {
      // Allow explicit retry even when frozen
    } else if (this.pendingCount === 0 && this.status !== "error" && this.status !== "offline") {
      this.status = "synced";
      this.emit();
      return this.getState();
    }

    this.flushing = true;
    this.status = "syncing";
    this.lastAttemptAt = new Date().toISOString();
    this.emit();
    this.flushCount += 1;

    const toPush = this.pendingCount;

    try {
      const result = await this.storage.push();
      if (result.ok) {
        this.pendingCount = Math.max(0, this.pendingCount - toPush);
        this.lastError = undefined;
        this.errorKind = undefined;
        this.errorTitle = undefined;
        this.errorDetail = undefined;
        this.conflictFiles = undefined;
        this.frozen = false;
        this.lastPushedSha = result.value.sha;
        this.status = this.pendingCount > 0 ? "pending" : "synced";
        if (this.pendingCount > 0) this.schedule();
      } else {
        const files =
          result.error.kind === "conflict" ? result.error.files : undefined;
        const msg =
          "message" in result.error
            ? result.error.message
            : result.error.kind === "not_found"
              ? `not found: ${result.error.path}`
              : String(result.error);
        const classified = classifyPushError(msg, { files });
        this.applyClassified(classified, msg, files);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.applyClassified(classifyPushError(msg), msg);
    } finally {
      this.flushing = false;
      this.emit();
    }
    return this.getState();
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

export function labelFor(status: SyncStatus, n: number): string {
  switch (status) {
    case "syncing":
      return n > 0 ? `● ${n} change${n === 1 ? "" : "s"} syncing…` : "● syncing…";
    case "pending":
      return n > 0
        ? `● ${n} change${n === 1 ? "" : "s"} pending…`
        : "● changes pending…";
    case "offline":
      return n > 0
        ? `⚠ offline — ${n} change${n === 1 ? "" : "s"} pending`
        : "⚠ offline — remote unreachable";
    case "frozen":
      return "⚠ conflict — sync frozen";
    case "error":
      return "⚠ push failed — retry";
    case "no_remote":
      return "○ local only (no remote)";
    default:
      return "✓ synced";
  }
}

export function defaultQueuePath(repoPath: string): string {
  return join(repoPath, ".kanbanly", "queue.json");
}
