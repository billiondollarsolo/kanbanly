import type { GitStorage } from "@kanbanly/core";
import type { BoardIndexStore } from "./index-store.ts";
import type { ConnectedRepo } from "./connect.ts";
import { refreshRepo } from "./connect.ts";

export type LiveEvent = {
  type: "board";
  sha: string;
  reason: "poll" | "write" | "hello";
  at: string;
};

export type LiveHubOptions = {
  connected?: ConnectedRepo;
  indexStore: BoardIndexStore;
  /** Poll interval ms (default 15000). */
  intervalMs?: number;
  /**
   * Run `git fetch` before reading SHA when a remote named origin exists.
   * Default true; tests may set false for pure local HEAD polling.
   */
  fetchRemote?: boolean;
};

type Client = {
  id: number;
  enqueue: (chunk: string) => void;
  close: () => void;
};

/**
 * Polls the boards repo for SHA changes and fans out SSE events.
 * Also accepts push notifications after local writes.
 */
export class LiveHub {
  private clients = new Map<number, Client>();
  private nextId = 1;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastSha = "";
  private running = false;
  readonly intervalMs: number;
  private fetchRemote: boolean;
  private lastFetchError = "";
  /** Most recent fetch error, exposed so /api/refresh can report it. */
  lastFetchErrorPublic = "";
  private connected?: ConnectedRepo;
  private indexStore: BoardIndexStore;
  /** Test counter: how many poll ticks ran. */
  tickCount = 0;
  /** Test counter: events broadcast (excluding hello if desired — includes all). */
  broadcastCount = 0;

  constructor(options: LiveHubOptions) {
    this.connected = options.connected;
    this.indexStore = options.indexStore;
    this.intervalMs = options.intervalMs ?? 15_000;
    this.fetchRemote = options.fetchRemote ?? true;
    if (options.connected) {
      this.lastSha = options.connected.index.sha || options.connected.storage.headSha();
    }
  }

  setConnected(connected: ConnectedRepo | undefined): void {
    this.connected = connected;
    if (connected) {
      this.lastSha = connected.index.sha || connected.storage.headSha();
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    // Immediate tick then interval
    void this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    // Don't keep process alive solely for the timer in tests
    if (typeof this.timer === "object" && this.timer && "unref" in this.timer) {
      (this.timer as NodeJS.Timeout).unref?.();
    }
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const c of this.clients.values()) {
      try {
        c.close();
      } catch {
        /* ignore */
      }
    }
    this.clients.clear();
  }

  clientCount(): number {
    return this.clients.size;
  }

  getLastSha(): string {
    return this.lastSha;
  }

  /**
   * One poll cycle: optional fetch, re-read HEAD, rebuild index if SHA changed,
   * broadcast to SSE clients.
   */
  async tick(): Promise<{ changed: boolean; sha: string }> {
    this.tickCount += 1;
    if (!this.connected) {
      return { changed: false, sha: this.lastSha };
    }

    if (this.fetchRemote) {
      const f = await tryFetchOrigin(this.connected.storage);
      // Surface it once rather than looping silently on a bad credential.
      if (f.error && f.error !== this.lastFetchError) {
        this.lastFetchError = f.error;
        console.warn(`[kanbanly] remote fetch failed: ${f.error}`);
      } else if (!f.error) {
        this.lastFetchError = "";
      }
      this.lastFetchErrorPublic = f.error ?? "";
    }

    const sha = this.connected.storage.headSha();
    if (!sha) {
      return { changed: false, sha: this.lastSha };
    }

    if (sha === this.lastSha) {
      // Cheap path: ensure() will no-op parse when SHA matches
      await refreshRepo(this.connected, { indexStore: this.indexStore });
      return { changed: false, sha };
    }

    this.lastSha = sha;
    await refreshRepo(this.connected, { indexStore: this.indexStore, force: true });
    this.connected.index = this.indexStore.get(this.connected.remoteKey)!;
    this.broadcast({
      type: "board",
      sha,
      reason: "poll",
      at: new Date().toISOString(),
    });
    return { changed: true, sha };
  }

  /** Call after local create/move commits so UIs update without waiting for poll. */
  notifyWrite(sha: string): void {
    if (!sha) return;
    this.lastSha = sha;
    this.broadcast({
      type: "board",
      sha,
      reason: "write",
      at: new Date().toISOString(),
    });
  }

  broadcast(event: LiveEvent): void {
    this.broadcastCount += 1;
    const payload = formatSse(event);
    for (const [id, c] of this.clients) {
      try {
        c.enqueue(payload);
      } catch {
        this.clients.delete(id);
      }
    }
  }

  /**
   * Subscribe a client to SSE. Returns a Response with text/event-stream body.
   */
  subscribe(): Response {
    const id = this.nextId++;
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    const encoder = new TextEncoder();

    const stream = new ReadableStream<Uint8Array>({
      start: (ctrl) => {
        controller = ctrl;
        const client: Client = {
          id,
          enqueue: (chunk) => {
            ctrl.enqueue(encoder.encode(chunk));
          },
          close: () => {
            try {
              ctrl.close();
            } catch {
              /* ignore */
            }
          },
        };
        this.clients.set(id, client);
        // Hello with current sha so clients can sync
        client.enqueue(
          formatSse({
            type: "board",
            sha: this.lastSha,
            reason: "hello",
            at: new Date().toISOString(),
          }),
        );
      },
      cancel: () => {
        this.clients.delete(id);
        controller = null;
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
      },
    });
  }
}

export function formatSse(event: LiveEvent): string {
  return `event: board\ndata: ${JSON.stringify(event)}\n\n`;
}

async function tryFetchOrigin(storage: GitStorage): Promise<{ error?: string }> {
  // Authenticated: a bare `git fetch` on a private repo fails with
  // "could not read Username" and, being swallowed as "offline", made the
  // poller silently never pull anyone else's commits.
  const r = storage.fetchAndFastForward();
  // FR-7: heal any conflict-markered card files left in the working tree
  try {
    await storage.healWorkingTree();
  } catch {
    /* non-fatal */
  }
  if (!r.ok) return { error: r.error };
  if (r.diverged) {
    return {
      error: `local branch has diverged from origin (${r.ahead} ahead, ${r.behind} behind) — cannot fast-forward`,
    };
  }
  return {};
}
