import { dirname, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  buildActivityFeed,
  CredentialStore,
  defaultCredentialPath,
  fetchPrStatus,
  isSpaBoardPath,
  orderAfter,
  orderForDrop,
  orderInitial,
  themeBootScript,
  type ConflictResolveChoice,
} from "@kanbanly/core";
import {
  connectLocalRepo,
  connectRemoteRepo,
  globalIndexStore,
  refreshRepo,
  type ConnectedRepo,
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
<html lang="en"><head><meta charset="utf-8"/><title>kanbanly</title></head>
<body style="font-family:system-ui;background:#0f1115;color:#e8eaed;padding:2rem">
  <h1>kanbanly</h1>
  <p>Board UI bundle missing. Run <code>bun run --filter @kanbanly/web build</code>.</p>
  <p>API still available at <code>/api/boards</code>.</p>
</body></html>`;
  }
  return `<!doctype html>
<html lang="en" data-theme="dark" data-theme-pref="system">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>kanbanly</title>
  <script>${themeBootScript()}</script>
  <link rel="stylesheet" href="/assets/main.css"/>
</head>
<body>
  <a class="kb-skip-link" href="#kb-main-board">Skip to board</a>
  <div id="root" data-testid="root" role="application" aria-label="kanbanly board application"></div>
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
  const pushDebounceMs = options.pushDebounceMs ?? 2000;
  const enablePushQueue = options.enablePushQueue !== false;

  if (connected && credentials?.has()) {
    connected.storage.setCredential(credentials.get());
  }

  function attachConnected(next: ConnectedRepo, preferredSlug?: string) {
    const entry = registry.add(next, preferredSlug);
    connected = entry.connected;
    credentials = new CredentialStore(defaultCredentialPath(next.path));
    if (credentials.has()) {
      next.storage.setCredential(credentials.get());
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

  return async function handler(req: Request): Promise<Response> {
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
      };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return json({ error: "invalid json" }, 400);
      }

      const credential =
        body.token?.trim()
          ? {
              token: body.token.trim(),
              username: body.username?.trim() || "x-access-token",
            }
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

    // Credential status (never returns secret)
    if (method === "GET" && path === "/api/credentials") {
      return json(credentials?.status() ?? { configured: false });
    }

    // Re-enter HTTPS credential for push
    if (method === "POST" && path === "/api/credentials") {
      if (!credentials || !connected) {
        return json({ error: "Credentials not available" }, 503);
      }
      let body: { token?: string; username?: string };
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
      return json({ ok: true, ...credentials.status() });
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
        path: b.path,
        columns: b.board.columns.map((c) => c.id),
        cardCount: b.cards.length,
      }));
      return json({ boards, sha: idx?.sha ?? null });
    }

    // Board detail: GET /api/boards/:boardId
    const boardMatch = path.match(/^\/api\/boards\/([^/]+)$/);
    if (method === "GET" && boardMatch) {
      if (!connected) return notFound("No repo connected");
      const boardId = decodeURIComponent(boardMatch[1]!);
      await refreshRepo(connected, { indexStore });
      const board = indexStore.getBoard(connected.remoteKey, boardId);
      if (!board) return notFound(`Board not found: ${boardId}`);
      return json(boardPayload(board));
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
      const body = await readJson<{ column?: string; order?: string }>(req);
      if (!body?.column) {
        return badRequest("Body must include { column, order? }");
      }

      await refreshRepo(connected, { indexStore });
      const board = indexStore.getBoard(connected.remoteKey, boardId);
      if (!board) return notFound(`Board not found: ${boardId}`);

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
        { actor: "human" },
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
      }>(req);
      if (!body || Object.keys(body).length === 0) {
        return badRequest("Body must include at least one field to update");
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
