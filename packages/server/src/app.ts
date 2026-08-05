import { dirname, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  boardBindingKey,
  buildActivityFeed,
  CredentialBook,
  CredentialStore,
  defaultCredentialPath,
  applySessionEnd,
  buildFleetHealth,
  buildPortfolio,
  checkDoingWip,
  countCommitsInWindow,
  formatFleetDigest,
  ensureCodeRepo,
  extractCardIdsFromText,
  watchGitHubCommits,
  parseGitHubRemote,
  resolveCodeBinding,
  type ProjectCommit,
  fetchPrStatus,
  githubCommitUrl,
  isDoingColumn,
  isHardWip,
  isSpaBoardPath,
  orderAfter,
  orderForDrop,
  orderInitial,
  themeBootScript,
  WorkspaceConfig,
  type ConflictResolveChoice,
  type GitCredential,
  GitStorage,
} from "@kanbanly/core";
import {
  connectLocalRepo,
  connectRemoteRepo,
  globalIndexStore,
  refreshRepo,
  type ConnectedRepo,
  ensureMergeDriver,
} from "./connect.ts";
import type { BoardIndexStore, IndexedBoard, IndexedCard } from "./index-store.ts";
import { LiveHub } from "./live.ts";
import { defaultQueuePath, PushQueue, type SyncState } from "./push-queue.ts";
import { RemoteRegistry } from "./remote-registry.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
/** Built React board UI (apps/web → packages/server/public). */
export const PUBLIC_DIR = join(SERVER_DIR, "..", "public");

export type AppOptions = {
  /** Connected local boards repo (required for board routes). */
  connected?: ConnectedRepo;
  indexStore?: BoardIndexStore;
  /** Optional live hub for SSE + poll (created by startServer if omitted). */
  live?: LiveHub;
  /** Background push queue after local commits. */
  pushQueue?: PushQueue;
  /** HTTPS credential store for push re-enter. */
  credentials?: CredentialStore;
  /**
   * Re-attach connections saved in workspace.json at boot. Off by default so a
   * handler built in a test never picks up the developer's real global
   * connections; startServer turns it on for the actual deployment.
   */
  rehydrateConnections?: boolean;

  /** Push debounce when auto-creating queue after connect wizard. */
  pushDebounceMs?: number;
  /** When false, never auto-create a push queue after connect. */
  enablePushQueue?: boolean;
};

export type ServeOptions = AppOptions & {
  host?: string;
  port?: number;
  /** Poll interval for git HEAD / fetch (default 15000). */
  pollIntervalMs?: number;
  /** Whether poll runs git fetch (default true). */
  fetchRemote?: boolean;
  /** Auto-start poll loop (default true when connected). */
  startLive?: boolean;
  /** Push debounce ms (default 2000). */
  pushDebounceMs?: number;
  /** Disable creating a push queue even when connected. */
  enablePushQueue?: boolean;
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** True when this board is bound in watch mode (no clone should be probed). */
function isWatchBinding(connected: unknown, boardId: string): boolean {
  try {
    const storage = (connected as { storage?: unknown }).storage as {
      readBoardSync?: (id: string) => { ok: boolean; value?: { settings?: Record<string, unknown> } };
    };
    const r = storage.readBoardSync?.(boardId);
    if (!r || !r.ok) return false;
    return resolveCodeBinding(r.value?.settings)?.watch === true;
  } catch {
    return false;
  }
}

/**
 * Pick a credential that can read this repo. Watch mode only ever needs read
 * access, so any stored credential for the host will do; private repos simply
 * return no commits without one.
 */
function resolveWatchToken(
  book: { list: () => Array<{ id: string }>; get: (id: string) => { token?: string } | null },
  remote: string,
  credentialId?: string,
): string | null {
  if (!parseGitHubRemote(remote)) return null;
  // A board naming its credential wins — that is the point of saving one.
  if (credentialId?.trim()) {
    try {
      const named = book.get(credentialId.trim());
      if (named?.token) return named.token;
    } catch {
      /* fall through to the looser lookups */
    }
  }
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  // Last resort: a single saved credential is unambiguous. More than one and we
  // refuse to guess, so a board without an explicit credentialId stays honest.
  try {
    const all = book.list();
    if (all.length === 1) {
      const only = book.get(all[0]!.id);
      if (only?.token) return only.token;
    }
  } catch {
    /* ignore — watch degrades to unauthenticated */
  }
  return null;
}

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function notFound(message: string): Response {
  return json({ error: message }, 404);
}

function badRequest(message: string): Response {
  return json({ error: message }, 400);
}

async function readJson<T>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function boardPayload(board: IndexedBoard) {
  // Group unknown-column quarantine by column id for UI lanes
  const unknownByColumn: Record<string, typeof board.cards> = {};
  for (const c of board.cards) {
    if (!c.unknownColumn) continue;
    const bucket = unknownByColumn[c.column] ?? (unknownByColumn[c.column] = []);
    bucket.push(c);
  }
  const parseErrors = board.quarantine.filter((q) => q.kind === "parse_error");
  const unknownColumns = [
    ...new Set(
      board.quarantine
        .filter((q) => q.kind === "unknown_column" && q.column)
        .map((q) => q.column!),
    ),
  ];

  return {
    id: board.id,
    title: board.board.title?.trim() || board.id,
    path: board.path,
    columns: board.board.columns,
    labels: board.board.labels,
    settings: board.board.settings,
    cardsByColumn: board.cardsByColumn,
    cards: board.cards,
    quarantine: board.quarantine,
    parseErrors,
    unknownColumns,
    unknownByColumn,
  };
}

/**
 * Primary board UI shell — loads the React + Pragmatic DnD client.
 * Falls back to a minimal static dump only if the bundle is missing.
 */
export function renderBoardAppHtml(): string {
  const hasBundle = existsSync(join(PUBLIC_DIR, "main.js"));
  if (!hasBundle) {
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/><title>kanbanly · Kanban for ADHD</title></head>
<body style="font-family:system-ui;background:#0f1115;color:#e8eaed;padding:2rem">
  <h1>kanbanly</h1>
  <p style="opacity:.75">Kanban for ADHD</p>
  <p>Board UI bundle missing. Run <code>bun run --filter @kanbanly/web build</code>.</p>
  <p>API still available at <code>/api/boards</code>.</p>
</body></html>`;
  }
  return `<!doctype html>
<html lang="en" data-theme="dark" data-theme-pref="system">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>kanbanly · Kanban for ADHD</title>
  <meta name="description" content="kanbanly — Kanban for ADHD. Self-hosted git-backed boards for humans and coding agents."/>
  <link rel="icon" href="/assets/favicon.svg" type="image/svg+xml"/>
  <link rel="apple-touch-icon" href="/assets/logo.svg"/>
  <link rel="preconnect" href="https://fonts.googleapis.com"/>
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
  <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap" rel="stylesheet"/>
  <script>${themeBootScript()}</script>
  <link rel="stylesheet" href="/assets/main.css"/>
</head>
<body>
  <a class="kb-skip-link" href="#kb-main-board">Skip to board</a>
  <div id="root" data-testid="root" role="application" aria-label="kanbanly — Kanban for ADHD"></div>
  <div id="kb-sr-live" class="kb-sr-only" aria-live="polite" aria-atomic="true" data-testid="sr-live"></div>
  <script type="module" src="/assets/main.js"></script>
</body>
</html>`;
}

/** Legacy static HTML for tests that inspect server-rendered markers. */
export function renderBoardHtml(boards: IndexedBoard[]): string {
  if (boards.length === 0) {
    return `<!doctype html><html><head><title>kanbanly</title></head><body>
<h1>kanbanly</h1><p>No boards connected. Start with <code>--repo &lt;path&gt;</code>.</p>
</body></html>`;
  }

  const sections = boards
    .map((b) => {
      const cols = b.board.columns
        .map((col) => {
          const cards = b.cardsByColumn[col.id] ?? [];
          const cardsHtml = cards
            .map(
              (c: IndexedCard) =>
                `<li class="card" data-card-id="${escapeHtml(c.id)}" data-column="${escapeHtml(c.column)}">
  <strong class="card-title">${escapeHtml(c.title)}</strong>
  <span class="card-id">${escapeHtml(c.id)}</span>
</li>`,
            )
            .join("\n");
          return `<section class="column" data-column-id="${escapeHtml(col.id)}">
  <h3>${escapeHtml(col.name)} <span class="count">(${cards.length})</span></h3>
  <ul class="cards">${cardsHtml || "<li class=\"empty\">Empty</li>"}</ul>
</section>`;
        })
        .join("\n");

      return `<article class="board" data-board-id="${escapeHtml(b.id)}">
  <h2>Board: ${escapeHtml(b.id)}</h2>
  <div class="columns">${cols}</div>
</article>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <title>kanbanly (static)</title>
</head>
<body>
  <h1>kanbanly</h1>
  ${sections}
</body>
</html>`;
}

function contentTypeFor(filePath: string): string {
  if (filePath.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".map")) return "application/json; charset=utf-8";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}

function servePublic(pathname: string): Response | null {
  // /assets/main.js → public/main.js
  const prefix = "/assets/";
  if (!pathname.startsWith(prefix)) return null;
  const rel = pathname.slice(prefix.length).replace(/\.\./g, "");
  if (!rel || rel.includes("..")) return null;
  const abs = join(PUBLIC_DIR, rel);
  if (!abs.startsWith(PUBLIC_DIR) || !existsSync(abs)) return null;
  const body = readFileSync(abs);
  return new Response(body, {
    headers: {
      "content-type": contentTypeFor(abs),
      "cache-control": "no-cache",
    },
  });
}

/**
 * Create a request handler for the kanbanly HTTP API.
 */
function previewSide(text: string): { column?: string; title?: string; status?: string } {
  const col = text.match(/^column:\s*(.+)$/m)?.[1]?.trim();
  const title = text.match(/^title:\s*(.+)$/m)?.[1]?.trim();
  const statusMatch = text.match(/^## Status\s*\n+([\s\S]*?)(?=\n## |\s*$)/m);
  const status = statusMatch?.[1]?.trim().slice(0, 120);
  return { column: col, title, status };
}

export function createHandler(options: AppOptions = {}) {
  const indexStore = options.indexStore ?? globalIndexStore;
  const registry = new RemoteRegistry(options.connected);
  let connected = options.connected;
  const live = options.live;
  let pushQueue = options.pushQueue;
  let credentials =
    options.credentials ??
    (connected
      ? new CredentialStore(defaultCredentialPath(connected.path))
      : undefined);
  const credentialBook = new CredentialBook();
  const workspace = new WorkspaceConfig();
  const pushDebounceMs = options.pushDebounceMs ?? 2000;
  const enablePushQueue = options.enablePushQueue !== false;

  if (connected && credentials?.has()) {
    connected.storage.setCredential(credentials.get());
  }

  /** Apply board- or connection-scoped credential from the book, else legacy store. */
  function applyResolvedCredential(
    remoteSlug: string | null | undefined,
    boardId?: string | null,
  ): void {
    if (!connected) return;
    let cred = credentials?.get() ?? null;
    if (remoteSlug) {
      const credId = boardId
        ? workspace.resolveCredentialId(remoteSlug, boardId)
        : workspace.get().connections.find((c) => c.id === remoteSlug)
            ?.defaultCredentialId ?? null;
      if (credId) {
        const fromBook = credentialBook.get(credId);
        if (fromBook) cred = fromBook;
      }
    }
    connected.storage.setCredential(cred);
  }

  function syncWorkspaceFromRegistry(): void {
    for (const e of registry.list()) {
      workspace.upsertConnection({
        id: e.slug,
        label: e.label,
        localPath: e.connected.path,
        remoteUrl: e.connected.remoteUrl ?? null,
        defaultCredentialId:
          workspace.get().connections.find((c) => c.id === e.slug)
            ?.defaultCredentialId ?? null,
      });
      for (const b of e.connected.index.boards) {
        const existing = workspace.getBoard(e.slug, b.id);
        workspace.upsertBoard({
          key: boardBindingKey(e.slug, b.id),
          boardId: b.id,
          boardDir: b.id,
          remoteSlug: e.slug,
          credentialId: existing?.credentialId ?? null,
          label: existing?.label ?? b.id,
        });
      }
    }
  }

  function attachConnected(next: ConnectedRepo, preferredSlug?: string) {
    const entry = registry.add(next, preferredSlug);
    connected = entry.connected;
    credentials = new CredentialStore(defaultCredentialPath(next.path));
    if (credentials.has()) {
      next.storage.setCredential(credentials.get());
    }
    // Record the connection BEFORE resolving its credential. The resolver reads
    // defaultCredentialId off the stored connection, so running it first meant a
    // first-time connect always resolved null and left the storage — and the
    // push queue built from it — with no credential at all.
    workspace.upsertConnection({
      id: entry.slug,
      label: entry.label,
      localPath: entry.connected.path,
      remoteUrl: entry.connected.remoteUrl ?? null,
      defaultCredentialId:
        workspace.get().connections.find((c) => c.id === entry.slug)
          ?.defaultCredentialId ?? null,
    });
    applyResolvedCredential(entry.slug);
    for (const b of entry.connected.index.boards) {
      const existing = workspace.getBoard(entry.slug, b.id);
      workspace.upsertBoard({
        key: boardBindingKey(entry.slug, b.id),
        boardId: b.id,
        boardDir: b.id,
        remoteSlug: entry.slug,
        credentialId: existing?.credentialId ?? null,
        label: existing?.label ?? b.id,
      });
    }
    live?.setConnected(next);
    if (enablePushQueue) {
      pushQueue?.stop();
      pushQueue = new PushQueue({
        storage: next.storage,
        queuePath: defaultQueuePath(next.path),
        debounceMs: pushDebounceMs,
      });
    }
    return entry;
  }

  // Seed workspace from initial connection
  if (connected) {
    try {
      syncWorkspaceFromRegistry();
    } catch {
      /* ignore */
    }
  }

  /**
   * Re-attach connections saved in workspace.json.
   *
   * Everything needed already persists — the connection entry, its
   * defaultCredentialId, and the clone on disk — but nothing read it back, so a
   * restart left the server knowing only the repo it was launched with and every
   * previously connected remote silently disappeared from the UI.
   *
   * Best-effort per connection: a missing or unreadable clone must not stop the
   * server from starting, or one stale entry would take the whole app down.
   */
  async function rehydrateSavedConnections(): Promise<{
    restored: string[];
    skipped: string[];
  }> {
    const restored: string[] = [];
    const skipped: string[] = [];
    let saved: ReturnType<typeof workspace.get>;
    try {
      saved = workspace.get();
    } catch {
      return { restored, skipped };
    }
    for (const conn of saved.connections ?? []) {
      const localPath = conn.localPath?.trim();
      if (!conn.id || !localPath) continue;
      // Already attached (e.g. it is the repo we booted with).
      if (registry.list().some((e) => e.slug === conn.id)) continue;
      if (!existsSync(join(localPath, ".git"))) {
        skipped.push(`${conn.id} (no clone at ${localPath})`);
        continue;
      }
      try {
        const storage = new GitStorage({
          repoPath: localPath,
          remoteUrl: conn.remoteUrl ?? undefined,
        });
        const cred = conn.defaultCredentialId
          ? credentialBook.get(conn.defaultCredentialId)
          : null;
        if (cred) storage.setCredential(cred);
        ensureMergeDriver(localPath);
        const { index } = await indexStore.ensure(localPath, storage);
        registry.add(
          {
            path: localPath,
            remoteKey: localPath,
            storage,
            index,
            remoteUrl: conn.remoteUrl ?? undefined,
          },
          conn.id,
        );
        restored.push(conn.id);
      } catch (e) {
        skipped.push(`${conn.id} (${e instanceof Error ? e.message : String(e)})`);
      }
    }
    return { restored, skipped };
  }

  // Started at boot, awaited once by the handler so no request can observe a
  // half-restored registry. Never rejects: startup must not hinge on it.
  const rehydration: Promise<void> = (
    options.rehydrateConnections ? rehydrateSavedConnections() : Promise.resolve({ restored: [], skipped: [] })
  )
    .then((r) => {
      for (const skipped of r.skipped) {
        console.warn(`[kanbanly] could not restore connection ${skipped}`);
      }
      try {
        syncWorkspaceFromRegistry();
      } catch {
        /* ignore */
      }
    })
    .catch(() => undefined);

  return async function handler(req: Request): Promise<Response> {
    await rehydration;
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method.toUpperCase();

    // Health
    if (method === "GET" && path === "/health") {
      return json({
        ok: true,
        live: live
          ? {
              clients: live.clientCount(),
              sha: live.getLastSha(),
              intervalMs: live.intervalMs,
            }
          : null,
        sync: pushQueue?.getState() ?? null,
        credentials: credentials?.status() ?? { configured: false },
        connected: connected
          ? {
              path: connected.path,
              remoteUrl: connected.remoteUrl ?? null,
              sha: connected.index.sha,
              boards: connected.index.boards.length,
              slug: registry.active()?.slug ?? null,
            }
          : null,
        remotes: registry.summaries(),
      });
    }

    // Multi-remote list
    if (method === "GET" && path === "/api/remotes") {
      return json({
        remotes: registry.summaries(),
        active: registry.active()?.slug ?? null,
      });
    }

    // Switch active remote
    if (method === "POST" && path === "/api/remotes/active") {
      let body: { slug?: string };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return json({ error: "invalid json" }, 400);
      }
      if (!body.slug || !registry.setActive(body.slug)) {
        return json({ error: "unknown remote slug" }, 404);
      }
      const entry = registry.active()!;
      connected = entry.connected;
      credentials = new CredentialStore(defaultCredentialPath(entry.connected.path));
      if (credentials.has()) {
        entry.connected.storage.setCredential(credentials.get());
      }
      applyResolvedCredential(entry.slug);
      live?.setConnected(entry.connected);
      if (enablePushQueue) {
        pushQueue?.stop();
        pushQueue = new PushQueue({
          storage: entry.connected.storage,
          queuePath: defaultQueuePath(entry.connected.path),
          debounceMs: pushDebounceMs,
        });
      }
      return json({
        ok: true,
        active: entry.slug,
        remotes: registry.summaries(),
      });
    }

    // Connect status
    if (method === "GET" && path === "/api/connect") {
      if (!connected) {
        return json({ connected: false, remotes: registry.summaries() });
      }
      return json({
        connected: true,
        slug: registry.active()?.slug ?? null,
        path: connected.path,
        remoteUrl: connected.remoteUrl ?? null,
        sha: connected.index.sha,
        boards: connected.index.boards.map((b) => b.id),
        cardCount: connected.index.cards.length,
        remotes: registry.summaries(),
      });
    }

    // Connect wizard: local path or remote URL + optional credential
    if (method === "POST" && path === "/api/connect") {
      let body: {
        path?: string;
        url?: string;
        token?: string;
        username?: string;
        scaffold?: boolean;
        board?: string;
        cloneDir?: string;
        /** Reuse a saved credential from the credential book. */
        credentialId?: string;
      };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return json({ error: "invalid json" }, 400);
      }

      // A pasted token wins; otherwise reuse a saved credential by id, so the
      // book is the single place a PAT is entered.
      const credential = body.token?.trim()
        ? {
            token: body.token.trim(),
            username: body.username?.trim() || "x-access-token",
          }
        : body.credentialId?.trim()
          ? credentialBook.get(body.credentialId.trim())
          : null;

      try {
        let next: ConnectedRepo;
        if (body.path?.trim()) {
          next = await connectLocalRepo(body.path.trim(), {
            indexStore,
            credential,
            scaffold: body.scaffold !== false,
            board: body.board,
          });
        } else if (body.url?.trim()) {
          next = await connectRemoteRepo(body.url.trim(), {
            indexStore,
            credential,
            scaffold: body.scaffold !== false,
            board: body.board,
            cloneDir: body.cloneDir,
          });
        } else {
          return json(
            { error: "Provide path (local repo) or url (git remote)" },
            400,
          );
        }
        const entry = attachConnected(next);
        // Remember WHICH saved credential this connection uses. Without this the
        // credentialId authenticates the initial clone and is then forgotten,
        // so every later fetch and push runs unauthenticated and fails with
        // "could not read Username" — silently, because fetch failure is
        // treated as "offline".
        if (body.credentialId?.trim()) {
          const existing = workspace
            .get()
            .connections.find((c) => c.id === entry.slug);
          workspace.upsertConnection({
            id: entry.slug,
            label: existing?.label ?? entry.label,
            localPath: next.path,
            remoteUrl: next.remoteUrl ?? null,
            defaultCredentialId: body.credentialId.trim(),
          });
          applyResolvedCredential(entry.slug);
        }
        return json({
          ok: true,
          connected: true,
          slug: entry.slug,
          path: next.path,
          remoteUrl: next.remoteUrl ?? null,
          sha: next.index.sha,
          boards: next.index.boards.map((b) => ({
            id: b.id,
            cardCount: b.cards.length,
          })),
          cardCount: next.index.cards.length,
          remotes: registry.summaries(),
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return json({ error: msg }, 400);
      }
    }

    // Sync status for header indicator
    if (method === "GET" && path === "/api/sync") {
      return json(pushQueue?.getState() ?? { status: "synced", pendingCount: 0, label: "✓ synced" });
    }

    // PR overlay: GET /api/pr-status?pr=... or batch ?prs=a,b
    if (method === "GET" && path === "/api/pr-status") {
      const batch = url.searchParams.get("prs");
      if (batch) {
        const refs = batch
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        const results: Record<string, Awaited<ReturnType<typeof fetchPrStatus>>> =
          {};
        await Promise.all(
          refs.map(async (pr) => {
            results[pr] = await fetchPrStatus(pr);
          }),
        );
        return json({ statuses: results });
      }
      const pr = url.searchParams.get("pr") ?? "";
      const status = await fetchPrStatus(pr);
      if (!status) return json({ error: "invalid pr ref" }, 400);
      return json(status);
    }

    // Retry failed / pending push immediately
    if (method === "POST" && path === "/api/sync/retry") {
      if (!pushQueue) return json({ error: "Push queue not enabled" }, 503);
      const state = await pushQueue.flush();
      return json(state);
    }

    // Manual fetch/pull from origin + heal (FR-14 / user refresh)
    if (method === "POST" && path === "/api/sync/pull") {
      if (!connected) return json({ error: "No repo connected" }, 503);
      const pulled = await connected.storage.pullRemote();
      if (!pulled.ok) {
        return json({ error: pulled.error }, 400);
      }
      await refreshRepo(connected, { indexStore, force: true });
      if (pulled.value.sha) {
        live?.notifyWrite(pulled.value.sha);
      }
      return json({
        ok: true,
        ...pulled.value,
        sync: pushQueue?.getState() ?? null,
      });
    }

    // Clear conflict freeze after user resolved diverged cards
    if (method === "POST" && path === "/api/sync/clear-freeze") {
      if (!pushQueue) return json({ error: "Push queue not enabled" }, 503);
      pushQueue.clearFreeze();
      return json(pushQueue.getState());
    }

    // Diverged cards for keep-mine / keep-theirs UI
    if (method === "GET" && path === "/api/conflicts") {
      if (!connected) return json({ error: "No repo connected" }, 503);
      const files = connected.storage.listConflicts();
      return json({
        conflicts: files.map((c) => ({
          path: c.path,
          boardId: c.boardId,
          cardId: c.cardId,
          title: c.title,
          oursPreview: previewSide(c.ours),
          theirsPreview: previewSide(c.theirs),
        })),
        count: files.length,
        sync: pushQueue?.getState() ?? null,
      });
    }

    // Resolve one diverged card
    if (method === "POST" && path === "/api/conflicts/resolve") {
      if (!connected) return json({ error: "No repo connected" }, 503);
      let body: { boardId?: string; cardId?: string; choice?: string };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return json({ error: "invalid json" }, 400);
      }
      const choice = body.choice as ConflictResolveChoice | undefined;
      if (!body.cardId || !choice || !["mine", "theirs", "heal"].includes(choice)) {
        return json(
          { error: "cardId and choice (mine|theirs|heal) required" },
          400,
        );
      }
      const boardId = body.boardId ?? ".";
      const result = await connected.storage.resolveConflict(
        boardId,
        body.cardId,
        choice,
      );
      if (!result.ok) {
        return json({ error: result.error }, 400);
      }
      await refreshRepo(connected, { indexStore, force: true });
      if (live) {
        live.notifyWrite(connected.storage.headSha());
      }
      const remaining = connected.storage.listConflicts();
      if (remaining.length === 0) {
        pushQueue?.markConflictsResolved();
      }
      if (result.value.sha) pushQueue?.enqueue(result.value.sha);
      return json({
        ok: true,
        ...result.value,
        remaining: remaining.length,
        sync: pushQueue?.getState() ?? null,
      });
    }

    // Credential status (never returns secret) — legacy single store + book
    // POST /api/refresh — force a fetch + reindex now, instead of waiting for
    // the 15s poll. Broadcasts to SSE clients so every open tab repaints.
    if (method === "POST" && path === "/api/refresh") {
      if (!connected) return notFound("No repo connected");
      const before = connected.storage.headSha();
      const result = await live?.tick();
      const after = connected.storage.headSha();
      if (!live) {
        // Live poller disabled: still do the work synchronously.
        await refreshRepo(connected, { indexStore, force: true });
      }
      return json({
        ok: true,
        changed: result?.changed ?? before !== after,
        sha: after || before,
        previousSha: before,
        boards: indexStore.get(connected.remoteKey)?.boards?.length ?? null,
        // Non-null when the remote could not be reached — otherwise a failed
        // fetch looks identical to "already up to date".
        fetchError: live?.lastFetchErrorPublic || null,
      });
    }

    if (method === "GET" && path === "/api/credentials") {
      return json({
        ...(credentials?.status() ?? { configured: false }),
        book: credentialBook.list(),
      });
    }

    // Named credential book (multi GitHub connections)
    if (method === "GET" && path === "/api/credentials/book") {
      return json({ credentials: credentialBook.list() });
    }
    if (method === "POST" && path === "/api/credentials/book") {
      const body = await readJson<{
        id?: string;
        label?: string;
        username?: string;
        token?: string;
      }>(req);
      if (!body?.label?.trim()) {
        return badRequest("Body must include { label }");
      }
      try {
        const entry = credentialBook.upsert({
          id: body.id,
          label: body.label,
          username: body.username,
          token: body.token,
        });
        return json({ ok: true, credential: entry }, body.id ? 200 : 201);
      } catch (e) {
        return badRequest(e instanceof Error ? e.message : String(e));
      }
    }
    const bookItem = path.match(/^\/api\/credentials\/book\/([^/]+)$/);
    if (method === "DELETE" && bookItem) {
      const id = decodeURIComponent(bookItem[1]!);
      const ok = credentialBook.remove(id);
      if (!ok) return notFound(`Credential not found: ${id}`);
      return json({ ok: true });
    }

    // Workspace: boards + connections + bindings (settings progressive disclosure)
    if (method === "GET" && path === "/api/workspace") {
      try {
        syncWorkspaceFromRegistry();
      } catch {
        /* ignore */
      }
      const ws = workspace.get();
      const remotes = registry.summaries();
      const boards = remotes.flatMap((r) =>
        r.boards.map((b) => {
          const binding = workspace.getBoard(r.slug, b.id);
          const indexed = registry
            .get(r.slug)
            ?.connected.index.boards.find((x) => x.id === b.id);
          const title =
            binding?.label?.trim() ||
            indexed?.board.title?.trim() ||
            b.id;
          return {
            key: boardBindingKey(r.slug, b.id),
            boardId: b.id,
            boardDir: binding?.boardDir ?? b.id,
            label: title,
            title,
            cardCount: b.cardCount,
            remoteSlug: r.slug,
            remoteLabel: r.label,
            localPath: r.path,
            remoteUrl: r.remoteUrl,
            credentialId: binding?.credentialId ?? null,
            connectionDefaultCredentialId:
              ws.connections.find((c) => c.id === r.slug)?.defaultCredentialId ??
              null,
            resolvedCredentialId: workspace.resolveCredentialId(r.slug, b.id),
            activeRemote: r.active,
            sha: r.sha,
          };
        }),
      );
      return json({
        connections: remotes.map((r) => {
          const cfg = ws.connections.find((c) => c.id === r.slug);
          return {
            id: r.slug,
            label: r.label,
            localPath: r.path,
            remoteUrl: r.remoteUrl,
            defaultCredentialId: cfg?.defaultCredentialId ?? null,
            active: r.active,
            boardCount: r.boards.length,
            cardCount: r.cardCount,
            sha: r.sha,
          };
        }),
        boards,
        credentials: credentialBook.list(),
        activeRemote: registry.active()?.slug ?? null,
      });
    }

    if (method === "PATCH" && path === "/api/workspace/connections") {
      const body = await readJson<{
        id?: string;
        defaultCredentialId?: string | null;
        label?: string;
      }>(req);
      if (!body?.id) return badRequest("Body must include { id }");
      const existing = workspace.get().connections.find((c) => c.id === body.id);
      const remote = registry.get(body.id);
      if (!existing && !remote) {
        return notFound(`Connection not found: ${body.id}`);
      }
      const updated = workspace.upsertConnection({
        id: body.id,
        label: body.label ?? existing?.label ?? remote?.label ?? body.id,
        localPath: existing?.localPath ?? remote?.connected.path ?? "",
        remoteUrl:
          existing?.remoteUrl ?? remote?.connected.remoteUrl ?? null,
        defaultCredentialId:
          body.defaultCredentialId !== undefined
            ? body.defaultCredentialId
            : (existing?.defaultCredentialId ?? null),
      });
      if (registry.active()?.slug === body.id) {
        applyResolvedCredential(body.id);
      }
      return json({ ok: true, connection: updated });
    }

    if (method === "PATCH" && path === "/api/workspace/boards") {
      const body = await readJson<{
        remoteSlug?: string;
        boardId?: string;
        /** Previous remote when rebinding board → another connection */
        fromRemoteSlug?: string;
        credentialId?: string | null;
        label?: string;
        boardDir?: string;
      }>(req);
      if (!body?.remoteSlug || !body?.boardId) {
        return badRequest("Body must include { remoteSlug, boardId }");
      }
      const fromSlug = body.fromRemoteSlug ?? body.remoteSlug;
      const existing =
        workspace.getBoard(fromSlug, body.boardId) ??
        workspace.getBoard(body.remoteSlug, body.boardId);
      if (fromSlug !== body.remoteSlug) {
        workspace.removeBoard(fromSlug, body.boardId);
      }
      const binding = workspace.upsertBoard({
        key: boardBindingKey(body.remoteSlug, body.boardId),
        boardId: body.boardId,
        boardDir: body.boardDir ?? existing?.boardDir ?? body.boardId,
        remoteSlug: body.remoteSlug,
        credentialId:
          body.credentialId !== undefined
            ? body.credentialId
            : (existing?.credentialId ?? null),
        label: body.label ?? existing?.label ?? body.boardId,
      });
      if (registry.active()?.slug === body.remoteSlug) {
        applyResolvedCredential(body.remoteSlug, body.boardId);
      }
      return json({ ok: true, board: binding });
    }

    // Re-enter HTTPS credential for push (legacy single store)
    if (method === "POST" && path === "/api/credentials") {
      if (!credentials || !connected) {
        return json({ error: "Credentials not available" }, 503);
      }
      let body: { token?: string; username?: string; label?: string; saveToBook?: boolean };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return json({ error: "invalid json" }, 400);
      }
      if (!body.token?.trim()) {
        return json({ error: "token required" }, 400);
      }
      credentials.set({ token: body.token, username: body.username });
      connected.storage.setCredential(credentials.get());
      let bookEntry = null;
      if (body.saveToBook || body.label) {
        try {
          bookEntry = credentialBook.upsert({
            label: body.label?.trim() || "GitHub PAT",
            username: body.username,
            token: body.token,
          });
        } catch {
          /* ignore book errors */
        }
      }
      return json({
        ok: true,
        ...credentials.status(),
        bookEntry,
        book: credentialBook.list(),
      });
    }

    if (method === "DELETE" && path === "/api/credentials") {
      if (!credentials || !connected) {
        return json({ error: "Credentials not available" }, 503);
      }
      credentials.clear();
      connected.storage.setCredential(null);
      return json({ ok: true, configured: false });
    }

    // SSE: board change notifications (poll + local writes)
    if (method === "GET" && path === "/api/events") {
      if (!live) {
        return json({ error: "Live updates not enabled" }, 503);
      }
      return live.subscribe();
    }

    // Static assets for React board UI
    if (method === "GET") {
      const asset = servePublic(path);
      if (asset) return asset;
    }

    // Primary board UI (React + Pragmatic DnD). Path deep links /r/.../b/... and /b/...
    if (method === "GET" && isSpaBoardPath(path)) {
      return html(renderBoardAppHtml());
    }

    // Server-rendered static dump (for simple agents / tests)
    if (method === "GET" && path === "/static-board") {
      if (!connected) {
        return html(renderBoardHtml([]));
      }
      await refreshRepo(connected, { indexStore });
      const idx = indexStore.get(connected.remoteKey);
      return html(renderBoardHtml(idx?.boards ?? []));
    }

    // List boards
    if (method === "GET" && path === "/api/boards") {
      if (!connected) return json({ boards: [] });
      await refreshRepo(connected, { indexStore });
      const idx = indexStore.get(connected.remoteKey);
      const boards = (idx?.boards ?? []).map((b) => ({
        id: b.id,
        title: b.board.title?.trim() || b.id,
        path: b.path,
        columns: b.board.columns.map((c) => c.id),
        cardCount: b.cards.length,
      }));
      return json({ boards, sha: idx?.sha ?? null });
    }

    // Portfolio / multi-project at-a-glance
    // GET /api/portfolio
    // Fleet health for unattended agents: GET /api/fleet-health
    if (
      method === "GET" &&
      (path === "/api/portfolio" || path === "/api/fleet-health")
    ) {
      if (!connected) {
        return json(
          path === "/api/fleet-health"
            ? {
                ok: true,
                boardCount: 0,
                issueCount: 0,
                highCount: 0,
                issues: [],
                tiles: [],
                summary: {
                  p0Total: 0,
                  staleTotal: 0,
                  wipOverBoards: 0,
                  silentBoards: 0,
                  blockedTotal: 0,
                },
                sha: null,
              }
            : {
                tiles: [],
                activity: [],
                p0Total: 0,
                staleTotal: 0,
                sha: null,
              },
        );
      }
      await refreshRepo(connected, { indexStore });
      const idx = indexStore.get(connected.remoteKey);
      const inputs = (idx?.boards ?? []).map((b) => {
        const settings = (b.board.settings ?? {}) as Record<string, unknown>;
        let codeCommits7d: number | null = null;
        let codeCommits24h: number | null = null;
        const hist = connected!.storage.codeHistory(b.id, { limit: 100 });
        if (hist.ok && hist.value.bound) {
          codeCommits7d = countCommitsInWindow(hist.value.commits, 7);
          codeCommits24h = countCommitsInWindow(hist.value.commits, 1);
        } else if (hist.ok && !hist.value.bound) {
          codeCommits7d = null;
          codeCommits24h = null;
        }
        return {
          id: b.id,
          title: b.board.title?.trim() || b.id,
          columns: b.board.columns.map((c) => ({ id: c.id, name: c.name })),
          cards: b.cards.map((c) => ({
            id: c.id,
            title: c.title,
            column: c.column,
            priority: c.priority,
            assignee: c.assignee,
            updated: c.updated,
            log: c.log,
          })),
          settings,
          codeCommits7d,
          codeCommits24h,
        };
      });
      if (path === "/api/fleet-health") {
        const silentH = Number(url.searchParams.get("silentHours") ?? 12);
        const staleH = Number(url.searchParams.get("staleHours") ?? 48);
        const health = buildFleetHealth(inputs, {
          silentHours: Number.isFinite(silentH) ? silentH : 12,
          staleHours: Number.isFinite(staleH) ? staleH : 48,
        });
        const format =
          url.searchParams.get("format")?.toLowerCase() ??
          (req.headers.get("accept")?.includes("text/plain")
            ? "text"
            : "json");
        if (format === "text" || format === "digest") {
          return new Response(formatFleetDigest(health), {
            status: 200,
            headers: {
              "content-type": "text/plain; charset=utf-8",
              "cache-control": "no-store",
            },
          });
        }
        return json({ ...health, sha: idx?.sha ?? null });
      }
      const portfolio = buildPortfolio(inputs, {
        activityLimit: 50,
        staleHours: 48,
        velocityDays: 7,
      });
      return json({
        ...portfolio,
        sha: idx?.sha ?? null,
      });
    }

    // Board detail: GET /api/boards/:boardId
    const boardMatch = path.match(/^\/api\/boards\/([^/]+)$/);
    if (method === "GET" && boardMatch) {
      if (!connected) return notFound("No repo connected");
      const boardId = decodeURIComponent(boardMatch[1]!);
      const slug = registry.active()?.slug ?? null;
      applyResolvedCredential(slug, boardId);
      await refreshRepo(connected, { indexStore });
      const board = indexStore.getBoard(connected.remoteKey, boardId);
      if (!board) return notFound(`Board not found: ${boardId}`);
      const binding = slug ? workspace.getBoard(slug, boardId) : null;
      return json({
        ...boardPayload(board),
        binding: binding
          ? {
              key: binding.key,
              remoteSlug: binding.remoteSlug,
              boardDir: binding.boardDir,
              credentialId: binding.credentialId ?? null,
              label: binding.label,
              resolvedCredentialId: slug
                ? workspace.resolveCredentialId(slug, boardId)
                : null,
              localPath: connected.path,
              remoteUrl: connected.remoteUrl ?? null,
            }
          : null,
      });
    }

    // Activity feed: GET /api/boards/:boardId/activity
    const activityMatch = path.match(/^\/api\/boards\/([^/]+)\/activity$/);
    if (method === "GET" && activityMatch) {
      if (!connected) return notFound("No repo connected");
      const boardId = decodeURIComponent(activityMatch[1]!);
      await refreshRepo(connected, { indexStore });
      const board = indexStore.getBoard(connected.remoteKey, boardId);
      if (!board) return notFound(`Board not found: ${boardId}`);
      const limitParam = url.searchParams.get("limit");
      const limit = limitParam ? Number(limitParam) : 100;
      const entries = buildActivityFeed(
        board.cards.map((c) => ({
          id: c.id,
          title: c.title,
          log: c.log,
        })),
        { limit: Number.isFinite(limit) ? limit : 100 },
      );
      return json({ boardId, entries, count: entries.length });
    }

    // Create board (layout A): POST /api/boards
    if (method === "POST" && path === "/api/boards") {
      const body = await readJson<{
        name?: string;
        id?: string;
        credentialId?: string | null;
        remoteSlug?: string;
        /** Optional board directory id (defaults to slugified name) */
        boardDir?: string;
      }>(req);
      if (!body?.name?.trim()) {
        return badRequest("Body must include { name }");
      }

      // Optionally target a specific connected repo (not only "active")
      if (body.remoteSlug && registry.get(body.remoteSlug)) {
        registry.setActive(body.remoteSlug);
        const entry = registry.active()!;
        connected = entry.connected;
        credentials = new CredentialStore(
          defaultCredentialPath(entry.connected.path),
        );
        if (credentials.has()) {
          entry.connected.storage.setCredential(credentials.get());
        }
        applyResolvedCredential(entry.slug);
        live?.setConnected(entry.connected);
      }

      if (!connected) return notFound("No repo connected");

      // Prefer random `b-…` ids; only honor explicit `id` (tests / advanced).
      const boardIdHint = body.id?.trim() || undefined;
      const created = await connected.storage.createBoard({
        name: body.name,
        id: boardIdHint,
      });
      if (!created.ok) {
        return json({ error: created.error }, 400);
      }
      const slug = registry.active()?.slug;
      if (slug) {
        workspace.upsertBoard({
          key: boardBindingKey(slug, created.value.boardId),
          boardId: created.value.boardId,
          boardDir: created.value.boardId,
          remoteSlug: slug,
          credentialId: body.credentialId ?? null,
          label: body.name.trim(),
        });
        applyResolvedCredential(slug, created.value.boardId);
      }
      await refreshRepo(connected, { indexStore, force: true });
      if (created.value.sha) {
        live?.notifyWrite(created.value.sha);
        pushQueue?.enqueue(created.value.sha);
      }
      return json(
        {
          ok: true,
          boardId: created.value.boardId,
          sha: created.value.sha,
          sync: pushQueue?.getState() ?? null,
          remoteSlug: slug ?? null,
        },
        201,
      );
    }

    // Add column (list): POST /api/boards/:boardId/columns
    // Reorder columns: PUT /api/boards/:boardId/columns  { order: string[] }
    const columnsCollectionMatch = path.match(
      /^\/api\/boards\/([^/]+)\/columns$/,
    );
    if (columnsCollectionMatch) {
      if (!connected) return notFound("No repo connected");
      const boardId = decodeURIComponent(columnsCollectionMatch[1]!);

      if (method === "POST") {
        const body = await readJson<{ name?: string; id?: string }>(req);
        if (!body?.name?.trim()) {
          return badRequest("Body must include { name }");
        }

        await refreshRepo(connected, { indexStore });
        const board = indexStore.getBoard(connected.remoteKey, boardId);
        if (!board) return notFound(`Board not found: ${boardId}`);

        const added = await connected.storage.addColumn(boardId, {
          name: body.name,
          id: body.id,
        });
        if (!added.ok) {
          return json({ error: added.error }, 400);
        }

        await refreshRepo(connected, { indexStore, force: true });
        if (added.value.sha) {
          live?.notifyWrite(added.value.sha);
          pushQueue?.enqueue(added.value.sha);
        }
        return json(
          {
            ok: true,
            column: added.value.column,
            columns: added.value.board.columns,
            sha: added.value.sha,
            sync: pushQueue?.getState() ?? null,
          },
          201,
        );
      }

      if (method === "PUT") {
        const body = await readJson<{ order?: string[] }>(req);
        if (!body?.order || !Array.isArray(body.order)) {
          return badRequest("Body must include { order: string[] }");
        }
        await refreshRepo(connected, { indexStore });
        const board = indexStore.getBoard(connected.remoteKey, boardId);
        if (!board) return notFound(`Board not found: ${boardId}`);

        const reordered = await connected.storage.reorderColumns(
          boardId,
          body.order,
        );
        if (!reordered.ok) {
          return json({ error: reordered.error }, 400);
        }
        await refreshRepo(connected, { indexStore, force: true });
        if (reordered.value.sha) {
          live?.notifyWrite(reordered.value.sha);
          pushQueue?.enqueue(reordered.value.sha);
        }
        return json({
          ok: true,
          columns: reordered.value.board.columns,
          sha: reordered.value.sha,
          sync: pushQueue?.getState() ?? null,
        });
      }
    }

    // Rename / delete one column
    const columnItemMatch = path.match(
      /^\/api\/boards\/([^/]+)\/columns\/([^/]+)$/,
    );
    if (columnItemMatch) {
      if (!connected) return notFound("No repo connected");
      const boardId = decodeURIComponent(columnItemMatch[1]!);
      const columnId = decodeURIComponent(columnItemMatch[2]!);

      if (method === "PATCH") {
        const body = await readJson<{ name?: string }>(req);
        if (!body?.name?.trim()) {
          return badRequest("Body must include { name }");
        }
        await refreshRepo(connected, { indexStore });
        const board = indexStore.getBoard(connected.remoteKey, boardId);
        if (!board) return notFound(`Board not found: ${boardId}`);

        const renamed = await connected.storage.renameColumn(
          boardId,
          columnId,
          body.name,
        );
        if (!renamed.ok) {
          return json({ error: renamed.error }, 400);
        }
        await refreshRepo(connected, { indexStore, force: true });
        if (renamed.value.sha) {
          live?.notifyWrite(renamed.value.sha);
          pushQueue?.enqueue(renamed.value.sha);
        }
        return json({
          ok: true,
          column: renamed.value.column,
          columns: renamed.value.board.columns,
          sha: renamed.value.sha,
          sync: pushQueue?.getState() ?? null,
        });
      }

      if (method === "DELETE") {
        const body = (await readJson<{ moveTo?: string }>(req)) ?? {};
        await refreshRepo(connected, { indexStore });
        const board = indexStore.getBoard(connected.remoteKey, boardId);
        if (!board) return notFound(`Board not found: ${boardId}`);

        const deleted = await connected.storage.deleteColumn(boardId, columnId, {
          moveTo: body.moveTo,
        });
        if (!deleted.ok) {
          return json({ error: deleted.error }, 400);
        }
        await refreshRepo(connected, { indexStore, force: true });
        if (deleted.value.sha) {
          live?.notifyWrite(deleted.value.sha);
          pushQueue?.enqueue(deleted.value.sha);
        }
        return json({
          ok: true,
          columns: deleted.value.board.columns,
          moved: deleted.value.moved ?? 0,
          archived: deleted.value.archived ?? 0,
          sha: deleted.value.sha,
          sync: pushQueue?.getState() ?? null,
        });
      }
    }

    // Create card: POST /api/boards/:boardId/cards
    const createMatch = path.match(/^\/api\/boards\/([^/]+)\/cards$/);
    if (method === "POST" && createMatch) {
      if (!connected) return notFound("No repo connected");
      const boardId = decodeURIComponent(createMatch[1]!);
      const body = await readJson<{ title?: string; column?: string }>(req);
      if (!body?.title || !body?.column) {
        return badRequest("Body must include { title, column }");
      }

      await refreshRepo(connected, { indexStore });
      const board = indexStore.getBoard(connected.remoteKey, boardId);
      if (!board) return notFound(`Board not found: ${boardId}`);

      const colCards = board.cardsByColumn[body.column] ?? [];
      const last = colCards.length > 0 ? colCards[colCards.length - 1]!.order : null;
      const order = orderAfter(last) || orderInitial();

      const created = await connected.storage.createCard(
        boardId,
        body.title,
        body.column,
        order,
        { actor: "human" },
      );
      if (!created.ok) {
        return json({ error: created.error }, 500);
      }

      // Force re-index after write (SHA changed)
      await refreshRepo(connected, { indexStore, force: true });
      if (created.value.sha) {
        live?.notifyWrite(created.value.sha);
        pushQueue?.enqueue(created.value.sha);
      }
      return json(
        {
          ok: true,
          card: {
            id: created.value.card.frontmatter.id,
            title: created.value.card.frontmatter.title,
            column: created.value.card.frontmatter.column,
            order: created.value.card.frontmatter.order,
          },
          sha: created.value.sha,
          sync: pushQueue?.getState() ?? null,
        },
        201,
      );
    }

    // Move card: POST /api/boards/:boardId/cards/:cardId/move
    const moveMatch = path.match(/^\/api\/boards\/([^/]+)\/cards\/([^/]+)\/move$/);
    if (method === "POST" && moveMatch) {
      if (!connected) return notFound("No repo connected");
      const boardId = decodeURIComponent(moveMatch[1]!);
      const cardId = decodeURIComponent(moveMatch[2]!);
      const body = await readJson<{
        column?: string;
        order?: string;
        actor?: string;
      }>(req);
      if (!body?.column) {
        return badRequest("Body must include { column, order? }");
      }

      await refreshRepo(connected, { indexStore });
      const board = indexStore.getBoard(connected.remoteKey, boardId);
      if (!board) return notFound(`Board not found: ${boardId}`);

      const moving = board.cards.find((c) => c.id === cardId);
      const settings = (board.board.settings ?? {}) as Record<string, unknown>;
      if (
        isDoingColumn(body.column) &&
        moving &&
        !isDoingColumn(moving.column) &&
        isHardWip(settings)
      ) {
        const doingN = board.cards.filter((c) => isDoingColumn(c.column)).length;
        const wip = checkDoingWip(doingN, settings, { movingIntoDoing: true });
        if (wip.over) {
          return json(
            {
              error: "wip_hard",
              message: wip.message ?? "Doing WIP limit reached",
              limit: wip.limit,
              count: wip.count,
            },
            409,
          );
        }
      }

      let newOrder = body.order;
      if (!newOrder) {
        // Default: append after last using core orderForDrop (index = end)
        const colCards = board.cardsByColumn[body.column] ?? [];
        newOrder = orderForDrop(
          colCards.map((c) => ({ id: c.id, order: c.order })),
          cardId,
          colCards.length,
        );
      }

      const moved = await connected.storage.moveCard(
        boardId,
        cardId,
        body.column,
        newOrder,
        { actor: body.actor?.trim() || "human" },
      );
      if (!moved.ok) {
        return json({ error: moved.error }, moved.error.kind === "not_found" ? 404 : 500);
      }

      await refreshRepo(connected, { indexStore, force: true });
      if (moved.value.sha) {
        live?.notifyWrite(moved.value.sha);
        pushQueue?.enqueue(moved.value.sha);
      }
      return json({
        ok: true,
        sha: moved.value.sha,
        column: body.column,
        order: newOrder,
        sync: pushQueue?.getState() ?? null,
      });
    }

    // Agent session-end (HTTP): POST /api/boards/:boardId/cards/:cardId/session-end
    const sessionEndMatch = path.match(
      /^\/api\/boards\/([^/]+)\/cards\/([^/]+)\/session-end$/,
    );
    if (method === "POST" && sessionEndMatch) {
      if (!connected) return notFound("No repo connected");
      const boardId = decodeURIComponent(sessionEndMatch[1]!);
      const cardId = decodeURIComponent(sessionEndMatch[2]!);
      const body = await readJson<{
        summary?: string;
        agent?: string;
        status?: string;
        sha?: string;
        moveToDoing?: boolean;
      }>(req);
      if (!body?.summary?.trim()) {
        return badRequest("Body must include { summary }");
      }
      await refreshRepo(connected, { indexStore });
      const read = await connected.storage.readCard(boardId, cardId);
      if (!read.ok) {
        return json(
          { error: read.error },
          read.error.kind === "not_found" ? 404 : 500,
        );
      }
      const actor = body.agent?.trim() || "agent";
      let ended;
      try {
        ended = applySessionEnd({
          card: read.value,
          summary: body.summary.trim(),
          actor,
          status: body.status,
          sha: body.sha,
        });
      } catch (e) {
        return badRequest(e instanceof Error ? e.message : String(e));
      }
      if (
        body.moveToDoing !== false &&
        ended.card.frontmatter.column === "ready"
      ) {
        ended.card.frontmatter.column = "doing";
      }
      const w = await connected.storage.writeCard(boardId, ended.card, {
        message: `chore(board): session-end ${cardId}`,
      });
      if (!w.ok) {
        return json({ error: w.error }, 500);
      }
      await refreshRepo(connected, { indexStore, force: true });
      if (w.value.sha) {
        live?.notifyWrite(w.value.sha);
        pushQueue?.enqueue(w.value.sha);
      }
      return json({
        ok: true,
        boardId,
        cardId,
        logLine: ended.logLine,
        column: ended.card.frontmatter.column,
        sha: w.value.sha,
        sync: pushQueue?.getState() ?? null,
      });
    }

    // Card git history: GET /api/boards/:boardId/cards/:cardId/history
    const historyMatch = path.match(
      /^\/api\/boards\/([^/]+)\/cards\/([^/]+)\/history$/,
    );
    if (method === "GET" && historyMatch) {
      if (!connected) return notFound("No repo connected");
      const boardId = decodeURIComponent(historyMatch[1]!);
      const cardId = decodeURIComponent(historyMatch[2]!);
      const limitParam = url.searchParams.get("limit");
      const limit = limitParam ? Number(limitParam) : 40;
      const hist = connected.storage.cardHistory(boardId, cardId, {
        limit: Number.isFinite(limit) ? limit : 40,
      });
      if (!hist.ok) {
        return json(
          { error: hist.error },
          hist.error.kind === "not_found" ? 404 : 500,
        );
      }
      return json({
        boardId,
        cardId,
        entries: hist.value,
        count: hist.value.length,
      });
    }

    // Project (code) commits — not boards-repo log
    // GET /api/boards/:boardId/code-history
    const codeHistMatch = path.match(
      /^\/api\/boards\/([^/]+)\/code-history$/,
    );
    if (method === "GET" && codeHistMatch) {
      if (!connected) return notFound("No repo connected");
      const boardId = decodeURIComponent(codeHistMatch[1]!);
      const limitParam = url.searchParams.get("limit");
      const limit = limitParam ? Number(limitParam) : 50;
      const hist = connected.storage.codeHistory(boardId, {
        limit: Number.isFinite(limit) ? limit : 50,
        // Watch mode must never touch (or create) a managed clone.
        allowManagedClone: !isWatchBinding(connected, boardId),
      });
      if (!hist.ok) {
        return json(
          { error: hist.error },
          hist.error.kind === "not_found" ? 404 : 500,
        );
      }
      const binding = hist.value.binding;

      // Watch mode: read commit metadata from the GitHub API, keeping zero
      // local state. Falls through to the git-log result on failure.
      if (binding?.watch && binding.remote) {
        const watched = await watchGitHubCommits({
          remote: binding.remote,
          token: resolveWatchToken(credentialBook, binding.remote, binding.credentialId),
          limit: Number.isFinite(limit) ? limit : 50,
        });
        const board = indexStore.getBoard(connected.remoteKey, boardId);
        const ids = new Set((board?.cards ?? []).map((c) => c.id.toLowerCase()));
        return json({
          boardId,
          source: "code",
          mode: "watch",
          bound: watched.ok,
          binding,
          codePath: null,
          error: watched.ok ? null : watched.error,
          rateRemaining: watched.rateRemaining ?? null,
          commits: watched.commits.map((c: ProjectCommit) => ({
            ...c,
            url: githubCommitUrl(binding.remote, c.sha),
            cardIds: extractCardIdsFromText(c.subject).filter((id) =>
              ids.has(id),
            ),
          })),
          count: watched.commits.length,
        });
      }
      const remote = binding?.remote;
      const board = indexStore.getBoard(connected.remoteKey, boardId);
      const cardIdSet = new Set(
        (board?.cards ?? []).map((c) => c.id.toLowerCase()),
      );
      const commits = hist.value.commits.map((c) => {
        const mentioned = extractCardIdsFromText(c.subject).filter((id) =>
          cardIdSet.has(id),
        );
        return {
          ...c,
          url: githubCommitUrl(remote, c.sha),
          cardIds: mentioned,
        };
      });
      return json({
        boardId,
        source: "code",
        bound: hist.value.bound,
        binding: hist.value.binding,
        codePath: hist.value.codePath ?? null,
        error: hist.value.error ?? null,
        commits,
        count: commits.length,
      });
    }

    // PATCH /api/boards/:boardId/code-binding  { path?, remote?, clear? }
    // POST  /api/boards/:boardId/code-source   { url|remote?, path?, token?, username?, credentialId? }
    //   → clone remote into ~/.kanbanly/code-clones if needed, bind board, return history
    const codeBindMatch = path.match(
      /^\/api\/boards\/([^/]+)\/code-binding$/,
    );
    const codeSourceMatch = path.match(
      /^\/api\/boards\/([^/]+)\/code-source$/,
    );
    if (
      (method === "PATCH" && codeBindMatch) ||
      (method === "POST" && codeSourceMatch)
    ) {
      if (!connected) return notFound("No repo connected");
      const boardId = decodeURIComponent(
        (codeBindMatch ?? codeSourceMatch)![1]!,
      );
      const body = await readJson<{
        path?: string | null;
        remote?: string | null;
        url?: string | null;
        clear?: boolean;
        token?: string;
        username?: string;
        credentialId?: string;
        fetch?: boolean;
        /** Read commits from the forge API; never clone. */
        watch?: boolean;
      }>(req);

      if (body?.clear) {
        const result = await connected.storage.setCodeBinding(boardId, null);
        if (!result.ok) {
          return json(
            { error: result.error },
            result.error.kind === "not_found" ? 404 : 400,
          );
        }
        if (result.value.sha) {
          live?.notifyWrite(result.value.sha);
          pushQueue?.enqueue(result.value.sha);
        }
        return json({
          ok: true,
          boardId,
          cleared: true,
          settings: result.value.board.settings ?? {},
          sha: result.value.sha,
          sync: pushQueue?.getState() ?? null,
        });
      }

      const remote =
        body?.remote?.trim() || body?.url?.trim() || undefined;
      let pathIn = body?.path?.trim() || undefined;

      // Resolve credential: explicit token → book id → active boards store
      let cred: GitCredential | null = null;
      if (body?.token?.trim()) {
        cred = {
          token: body.token.trim(),
          username: body.username?.trim() || "x-access-token",
        };
      } else if (body?.credentialId?.trim()) {
        cred = credentialBook.get(body.credentialId.trim());
      } else if (credentials?.has()) {
        cred = credentials.get();
      }

      let ensured: {
        path: string;
        remote: string | null;
        cloned: boolean;
        fetched: boolean;
      } | null = null;
      const wantsWatch = body?.watch === true;
      if (wantsWatch && !remote) {
        return badRequest("Watch mode requires a remote URL");
      }
      if (wantsWatch && !parseGitHubRemote(remote)) {
        return badRequest(
          "Watch mode supports github.com remotes only; omit watch to clone instead",
        );
      }
      try {
        // Watch mode deliberately does not call ensureCodeRepo: nothing is
        // cloned, nothing is written to ~/.kanbanly/code-clones.
        if (!wantsWatch && (pathIn || remote)) {
          ensured = ensureCodeRepo({
            path: pathIn,
            remote,
            credential: cred,
            fetch: body?.fetch !== false && !!remote,
          });
          pathIn = ensured.path;
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return json({ error: msg }, 400);
      }

      if (!pathIn && !remote) {
        return badRequest(
          "Provide path and/or remote (url) to bind a source code repo",
        );
      }

      const result = await connected.storage.setCodeBinding(boardId, {
        path: wantsWatch ? undefined : pathIn,
        remote: remote || ensured?.remote || undefined,
        watch: wantsWatch ? true : undefined,
        // Persisted so every later watch read can find its token.
        credentialId: body?.credentialId?.trim() || undefined,
      });
      if (!result.ok) {
        return json(
          { error: result.error },
          result.error.kind === "not_found" ? 404 : 400,
        );
      }
      await refreshRepo(connected, { indexStore, force: true });
      if (result.value.sha) {
        live?.notifyWrite(result.value.sha);
        pushQueue?.enqueue(result.value.sha);
      }

      const hist = connected.storage.codeHistory(boardId, { limit: 30 });
      return json({
        ok: true,
        boardId,
        settings: result.value.board.settings ?? {},
        sha: result.value.sha,
        source: ensured
          ? {
              path: ensured.path,
              remote: ensured.remote,
              cloned: ensured.cloned,
              fetched: ensured.fetched,
            }
          : null,
        history: hist.ok
          ? {
              bound: hist.value.bound,
              commits: hist.value.commits,
              count: hist.value.commits.length,
              error: hist.value.error ?? null,
              codePath: hist.value.codePath ?? null,
            }
          : null,
        sync: pushQueue?.getState() ?? null,
      });
    }

    // Project notes: GET/PUT /api/boards/:boardId/notes
    const notesMatch = path.match(/^\/api\/boards\/([^/]+)\/notes$/);
    if (notesMatch) {
      if (!connected) return notFound("No repo connected");
      const boardId = decodeURIComponent(notesMatch[1]!);
      if (method === "GET") {
        const n = connected.storage.readNotes(boardId);
        if (!n.ok) {
          return json(
            { error: n.error },
            n.error.kind === "not_found" ? 404 : 500,
          );
        }
        return json({
          boardId,
          body: n.value.body,
          path: n.value.path,
          exists: n.value.exists,
        });
      }
      if (method === "PUT") {
        const body = await readJson<{ body?: string }>(req);
        if (typeof body?.body !== "string") {
          return badRequest("Body must include { body: string }");
        }
        const board = indexStore.getBoard(connected.remoteKey, boardId);
        const title =
          board?.board.title?.trim() ||
          board?.id ||
          boardId;
        const w = await connected.storage.writeNotes(boardId, body.body, {
          title,
        });
        if (!w.ok) {
          return json(
            { error: w.error },
            w.error.kind === "not_found" ? 404 : 500,
          );
        }
        if (w.value.sha) {
          live?.notifyWrite(w.value.sha);
          pushQueue?.enqueue(w.value.sha);
        }
        return json({
          ok: true,
          boardId,
          path: w.value.path,
          sha: w.value.sha,
          sync: pushQueue?.getState() ?? null,
        });
      }
    }

    // Update card: PATCH /api/boards/:boardId/cards/:cardId
    const updateMatch = path.match(/^\/api\/boards\/([^/]+)\/cards\/([^/]+)$/);
    if (method === "PATCH" && updateMatch) {
      if (!connected) return notFound("No repo connected");
      const boardId = decodeURIComponent(updateMatch[1]!);
      const cardId = decodeURIComponent(updateMatch[2]!);
      const body = await readJson<{
        title?: string;
        status?: string;
        labels?: string[];
        assignee?: string | null;
        due?: string | null;
        priority?: string | null;
        column?: string;
        order?: string;
        checklist?: Array<{ text: string; done: boolean }>;
      }>(req);
      if (!body || Object.keys(body).length === 0) {
        return badRequest("Body must include at least one field to update");
      }
      if (body.checklist !== undefined) {
        if (
          !Array.isArray(body.checklist) ||
          body.checklist.some(
            (i) =>
              !i ||
              typeof i.text !== "string" ||
              i.text.trim().length === 0 ||
              typeof i.done !== "boolean",
          )
        ) {
          return badRequest(
            "checklist must be an array of { text: non-empty string, done: boolean }",
          );
        }
        // Normalise here so a newline can never smuggle extra markdown lines
        // into the card file.
        body.checklist = body.checklist.map((i) => ({
          text: i.text.replace(/\s+/g, " ").trim(),
          done: i.done,
        }));
      }

      await refreshRepo(connected, { indexStore });
      const updated = await connected.storage.updateCard(boardId, cardId, body, {
        actor: "human",
      });
      if (!updated.ok) {
        return json(
          { error: updated.error },
          updated.error.kind === "not_found" ? 404 : 500,
        );
      }
      await refreshRepo(connected, { indexStore, force: true });
      if (updated.value.sha) {
        live?.notifyWrite(updated.value.sha);
        pushQueue?.enqueue(updated.value.sha);
      }
      return json({
        ok: true,
        sha: updated.value.sha,
        card: {
          id: updated.value.card.frontmatter.id,
          title: updated.value.card.frontmatter.title,
          column: updated.value.card.frontmatter.column,
          order: updated.value.card.frontmatter.order,
          labels: updated.value.card.frontmatter.labels ?? [],
          assignee: updated.value.card.frontmatter.assignee,
          due: updated.value.card.frontmatter.due,
          priority: updated.value.card.frontmatter.priority,
          status: updated.value.card.status,
          checklist: updated.value.card.checklist ?? [],
          log: updated.value.card.log,
          updated: updated.value.card.frontmatter.updated,
        },
        sync: pushQueue?.getState() ?? null,
      });
    }

    // Remap unknown column → known column: POST /api/boards/:boardId/remap-column
    const remapMatch = path.match(/^\/api\/boards\/([^/]+)\/remap-column$/);
    if (method === "POST" && remapMatch) {
      if (!connected) return notFound("No repo connected");
      const boardId = decodeURIComponent(remapMatch[1]!);
      const body = await readJson<{ from?: string; to?: string }>(req);
      if (!body?.from || !body?.to) {
        return badRequest("Body must include { from, to } column ids");
      }

      await refreshRepo(connected, { indexStore });
      const board = indexStore.getBoard(connected.remoteKey, boardId);
      if (!board) return notFound(`Board not found: ${boardId}`);
      const known = new Set(board.board.columns.map((c) => c.id));
      if (!known.has(body.to)) {
        return badRequest(`Target column not in board.yml: ${body.to}`);
      }

      const toRemap = board.cards.filter(
        (c) => c.unknownColumn && c.column === body.from,
      );
      if (toRemap.length === 0) {
        return badRequest(`No cards in unknown column: ${body.from}`);
      }

      const remapped: string[] = [];
      let lastSha: string | undefined;
      for (const card of toRemap) {
        const updated = await connected.storage.updateCard(
          boardId,
          card.id,
          { column: body.to },
          { actor: "human", message: `chore(board): remap ${card.id} ${body.from} → ${body.to}` },
        );
        if (updated.ok) {
          remapped.push(card.id);
          lastSha = updated.value.sha;
        }
      }

      await refreshRepo(connected, { indexStore, force: true });
      if (lastSha) {
        live?.notifyWrite(lastSha);
        pushQueue?.enqueue(lastSha);
      }
      return json({
        ok: true,
        from: body.from,
        to: body.to,
        remapped,
        sha: lastSha,
        sync: pushQueue?.getState() ?? null,
      });
    }

    // Archive cards: POST /api/boards/:boardId/archive
    const archiveMatch = path.match(/^\/api\/boards\/([^/]+)\/archive$/);
    if (method === "POST" && archiveMatch) {
      if (!connected) return notFound("No repo connected");
      const boardId = decodeURIComponent(archiveMatch[1]!);
      const body = await readJson<{ cardIds?: string[]; olderThanKeep?: number }>(req);

      await refreshRepo(connected, { indexStore });
      const board = indexStore.getBoard(connected.remoteKey, boardId);
      if (!board) return notFound(`Board not found: ${boardId}`);

      let ids = body?.cardIds ?? [];
      if (ids.length === 0 && body?.olderThanKeep !== undefined) {
        // Archive done cards beyond the N most recent (by updated)
        const keep = Math.max(0, body.olderThanKeep);
        const done = (board.cardsByColumn["done"] ?? [])
          .slice()
          .sort((a, b) => (a.updated < b.updated ? 1 : a.updated > b.updated ? -1 : 0));
        ids = done.slice(keep).map((c) => c.id);
      }
      if (ids.length === 0) {
        return badRequest("No cards to archive (pass cardIds or olderThanKeep)");
      }

      const archived = await connected.storage.archiveCards(boardId, ids);
      if (!archived.ok) {
        return json({ error: archived.error }, 500);
      }
      await refreshRepo(connected, { indexStore, force: true });
      if (archived.value.sha) {
        live?.notifyWrite(archived.value.sha);
        pushQueue?.enqueue(archived.value.sha);
      }
      return json({
        ok: true,
        sha: archived.value.sha,
        archived: archived.value.archived,
        sync: pushQueue?.getState() ?? null,
      });
    }

    return notFound(`No route for ${method} ${path}`);
  };
}

export type StartedServer = ReturnType<typeof Bun.serve> & {
  live?: LiveHub;
  pushQueue?: PushQueue;
  stopLive?: () => void;
};

/**
 * Start the HTTP server with Bun.serve + optional LiveHub poll/SSE + push queue.
 * Returns the server instance (call `.stop()` to shut down; also stops live/queue).
 */
export function startServer(options: ServeOptions = {}): StartedServer {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 3847;
  const indexStore = options.indexStore ?? globalIndexStore;

  const live =
    options.live ??
    new LiveHub({
      connected: options.connected,
      indexStore,
      intervalMs: options.pollIntervalMs ?? 15_000,
      fetchRemote: options.fetchRemote ?? true,
    });

  let pushQueue = options.pushQueue;
  if (
    !pushQueue &&
    options.connected &&
    options.enablePushQueue !== false
  ) {
    pushQueue = new PushQueue({
      storage: options.connected.storage,
      queuePath: defaultQueuePath(options.connected.path),
      debounceMs: options.pushDebounceMs ?? 2000,
      onChange: (state: SyncState) => {
        // Piggyback sync state on live hub for any future listeners
        void state;
      },
    });
  }

  const handler = createHandler({
    connected: options.connected,
    indexStore,
    live,
    pushQueue,
    pushDebounceMs: options.pushDebounceMs,
    enablePushQueue: options.enablePushQueue,
    // Opt-in: the CLI `serve` command turns this on. Left off by default so a
    // server started inside a test never inherits real global connections.
    rehydrateConnections: options.rehydrateConnections ?? false,
  });

  const server = Bun.serve({
    hostname: host,
    port,
    fetch: handler,
    // SSE clients stay open; default Bun idleTimeout (10s) would kill them
    idleTimeout: 255,
  }) as StartedServer;

  const shouldStartLive = options.startLive !== false && !!options.connected;
  if (shouldStartLive) {
    live.start();
  }

  const originalStop = server.stop.bind(server);
  server.live = live;
  server.pushQueue = pushQueue;
  server.stopLive = () => {
    live.stop();
    pushQueue?.stop();
  };
  server.stop = (closeActiveConnections?: boolean) => {
    live.stop();
    pushQueue?.stop();
    return originalStop(closeActiveConnections);
  };

  return server;
}

/** Allow tests / callers to attach a connected repo after construction. */
export type { ConnectedRepo };
