/** Client for OSS board HTTP API — real server write path only. */

export type BoardColumn = { id: string; name: string };

export type BoardCard = {
  id: string;
  title: string;
  column: string;
  order: string;
  labels?: string[];
  assignee?: string;
  due?: string;
  priority?: string;
  pr?: string;
  branch?: string;
  status?: string;
  log?: string[];
  updated?: string;
  filename?: string;
  path?: string;
  unknownColumn?: boolean;
};

export type QuarantineItem = {
  kind: "parse_error" | "unknown_column";
  message: string;
  cardId?: string;
  title?: string;
  column?: string;
  filename?: string;
  path?: string;
};

export type BoardDetail = {
  id: string;
  path: string;
  columns: BoardColumn[];
  labels: unknown[];
  settings: Record<string, unknown>;
  cardsByColumn: Record<string, BoardCard[]>;
  cards: BoardCard[];
  quarantine?: QuarantineItem[];
  parseErrors?: QuarantineItem[];
  unknownColumns?: string[];
  unknownByColumn?: Record<string, BoardCard[]>;
};

export type BoardSummary = {
  id: string;
  path: string;
  columns: string[];
  cardCount: number;
};

export async function listBoards(): Promise<{
  boards: BoardSummary[];
  sha: string | null;
}> {
  const res = await fetch("/api/boards");
  if (!res.ok) throw new Error(`listBoards failed: ${res.status}`);
  return res.json();
}

export type ConnectStatus =
  | { connected: false }
  | {
      connected: true;
      path: string;
      remoteUrl: string | null;
      sha: string;
      boards: string[];
      cardCount: number;
    };

export type ConnectResult = {
  ok: boolean;
  connected: boolean;
  slug?: string;
  path: string;
  remoteUrl: string | null;
  sha: string;
  boards: Array<{ id: string; cardCount: number }>;
  cardCount: number;
  remotes?: RemoteSummary[];
  error?: string;
};

export type RemoteSummary = {
  slug: string;
  label: string;
  path: string;
  remoteUrl: string | null;
  sha: string;
  boards: Array<{ id: string; cardCount: number }>;
  cardCount: number;
  active: boolean;
};

export async function getConnect(): Promise<ConnectStatus> {
  const res = await fetch("/api/connect");
  if (!res.ok) throw new Error(`getConnect failed: ${res.status}`);
  return res.json();
}

export async function connectRepo(input: {
  path?: string;
  url?: string;
  token?: string;
  username?: string;
  scaffold?: boolean;
  board?: string;
}): Promise<ConnectResult> {
  const res = await fetch("/api/connect", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = (await res.json()) as ConnectResult & { error?: string };
  if (!res.ok) {
    throw new Error(body.error ?? `connect failed: ${res.status}`);
  }
  return body;
}

export async function listRemotes(): Promise<{
  remotes: RemoteSummary[];
  active: string | null;
}> {
  const res = await fetch("/api/remotes");
  if (!res.ok) throw new Error(`listRemotes failed: ${res.status}`);
  return res.json();
}

export async function setActiveRemote(slug: string): Promise<{
  ok: boolean;
  active: string;
  remotes: RemoteSummary[];
}> {
  const res = await fetch("/api/remotes/active", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ slug }),
  });
  if (!res.ok) throw new Error(`setActiveRemote failed: ${res.status} ${await res.text()}`);
  return res.json();
}

export async function getBoard(boardId: string): Promise<BoardDetail> {
  const res = await fetch(`/api/boards/${encodeURIComponent(boardId)}`);
  if (!res.ok) throw new Error(`getBoard failed: ${res.status}`);
  return res.json();
}

export async function moveCard(
  boardId: string,
  cardId: string,
  payload: { column: string; order: string },
): Promise<{
  ok: boolean;
  sha?: string;
  column: string;
  order: string;
  sync?: SyncState | null;
}> {
  const res = await fetch(
    `/api/boards/${encodeURIComponent(boardId)}/cards/${encodeURIComponent(cardId)}/move`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`moveCard failed: ${res.status} ${err}`);
  }
  return res.json();
}

export async function createCard(
  boardId: string,
  title: string,
  column: string,
): Promise<{
  ok: boolean;
  card: { id: string; title: string; column: string; order: string };
  sync?: SyncState | null;
}> {
  const res = await fetch(`/api/boards/${encodeURIComponent(boardId)}/cards`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title, column }),
  });
  if (!res.ok) throw new Error(`createCard failed: ${res.status}`);
  return res.json();
}

export type BoardLiveEvent = {
  type: "board";
  sha: string;
  reason: "poll" | "write" | "hello";
  at: string;
};

/**
 * Subscribe to server-sent board updates. Calls onEvent for each `board` event.
 * Returns an unsubscribe function.
 */
export function subscribeBoardEvents(
  onEvent: (ev: BoardLiveEvent) => void,
  onError?: (err: Event) => void,
): () => void {
  const es = new EventSource("/api/events");
  const handler = (msg: MessageEvent) => {
    try {
      const data = JSON.parse(String(msg.data)) as BoardLiveEvent;
      onEvent(data);
    } catch {
      /* ignore malformed */
    }
  };
  es.addEventListener("board", handler as EventListener);
  es.onmessage = handler; // fallback if event name stripped
  if (onError) es.onerror = onError;
  return () => {
    es.removeEventListener("board", handler as EventListener);
    es.close();
  };
}

export type SyncState = {
  status:
    | "synced"
    | "pending"
    | "syncing"
    | "error"
    | "no_remote"
    | "offline"
    | "frozen";
  pendingCount: number;
  lastError?: string;
  lastPushedSha?: string;
  label: string;
  errorKind?: "offline" | "credential" | "conflict" | "unknown";
  errorTitle?: string;
  errorDetail?: string;
  frozen?: boolean;
  conflictFiles?: string[];
};

export type ConflictItem = {
  path: string;
  boardId: string;
  cardId: string;
  title?: string;
  oursPreview?: { column?: string; title?: string; status?: string };
  theirsPreview?: { column?: string; title?: string; status?: string };
};

export type PrStatusResponse = {
  ref: { raw: string; label: string; url?: string; owner?: string; repo?: string; number?: number };
  state: "open" | "closed" | "merged" | "draft" | "unknown";
  title?: string;
  suggestedColumn?: string;
  source: "static" | "github";
};

export type CredentialStatus = {
  configured: boolean;
  username?: string;
  updatedAt?: string;
};

export async function getSync(): Promise<SyncState> {
  const res = await fetch("/api/sync");
  if (!res.ok) throw new Error(`getSync failed: ${res.status}`);
  return res.json();
}

export async function retrySync(): Promise<SyncState> {
  const res = await fetch("/api/sync/retry", { method: "POST" });
  if (!res.ok) throw new Error(`retrySync failed: ${res.status}`);
  return res.json();
}

export async function pullRemote(): Promise<{
  ok: boolean;
  sha: string;
  fetched: boolean;
  fastForwarded: boolean;
  healed: string[];
  sync?: SyncState | null;
}> {
  const res = await fetch("/api/sync/pull", { method: "POST" });
  if (!res.ok) throw new Error(`pullRemote failed: ${res.status} ${await res.text()}`);
  return res.json();
}

export async function clearSyncFreeze(): Promise<SyncState> {
  const res = await fetch("/api/sync/clear-freeze", { method: "POST" });
  if (!res.ok) throw new Error(`clearSyncFreeze failed: ${res.status}`);
  return res.json();
}

export async function listConflicts(): Promise<{
  conflicts: ConflictItem[];
  count: number;
  sync?: SyncState | null;
}> {
  const res = await fetch("/api/conflicts");
  if (!res.ok) throw new Error(`listConflicts failed: ${res.status}`);
  return res.json();
}

export async function resolveConflict(
  boardId: string,
  cardId: string,
  choice: "mine" | "theirs" | "heal",
): Promise<{
  ok: boolean;
  cardId: string;
  choice: string;
  remaining: number;
  sync?: SyncState | null;
}> {
  const res = await fetch("/api/conflicts/resolve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ boardId, cardId, choice }),
  });
  if (!res.ok) throw new Error(`resolveConflict failed: ${res.status} ${await res.text()}`);
  return res.json();
}

export async function getPrStatus(pr: string): Promise<PrStatusResponse | null> {
  const res = await fetch(`/api/pr-status?pr=${encodeURIComponent(pr)}`);
  if (!res.ok) return null;
  return res.json();
}

export async function getPrStatuses(
  prs: string[],
): Promise<Record<string, PrStatusResponse | null>> {
  if (prs.length === 0) return {};
  const res = await fetch(
    `/api/pr-status?prs=${encodeURIComponent(prs.join(","))}`,
  );
  if (!res.ok) return {};
  const body = (await res.json()) as {
    statuses: Record<string, PrStatusResponse | null>;
  };
  return body.statuses ?? {};
}

export async function getCredentials(): Promise<CredentialStatus> {
  const res = await fetch("/api/credentials");
  if (!res.ok) throw new Error(`getCredentials failed: ${res.status}`);
  return res.json();
}

export async function setCredentials(input: {
  token: string;
  username?: string;
}): Promise<CredentialStatus & { ok: boolean }> {
  const res = await fetch("/api/credentials", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`setCredentials failed: ${res.status} ${await res.text()}`);
  return res.json();
}

export async function clearCredentials(): Promise<{ ok: boolean; configured: boolean }> {
  const res = await fetch("/api/credentials", { method: "DELETE" });
  if (!res.ok) throw new Error(`clearCredentials failed: ${res.status}`);
  return res.json();
}

export type CardUpdate = {
  title?: string;
  status?: string;
  labels?: string[];
  assignee?: string | null;
  due?: string | null;
  priority?: string | null;
  column?: string;
  order?: string;
};

export async function updateCard(
  boardId: string,
  cardId: string,
  patch: CardUpdate,
): Promise<{ ok: boolean; sha?: string; card: BoardCard; sync?: SyncState | null }> {
  const res = await fetch(
    `/api/boards/${encodeURIComponent(boardId)}/cards/${encodeURIComponent(cardId)}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    },
  );
  if (!res.ok) throw new Error(`updateCard failed: ${res.status} ${await res.text()}`);
  return res.json();
}

export async function archiveCards(
  boardId: string,
  body: { cardIds?: string[]; olderThanKeep?: number },
): Promise<{ ok: boolean; sha?: string; archived: string[]; sync?: SyncState | null }> {
  const res = await fetch(
    `/api/boards/${encodeURIComponent(boardId)}/archive`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) throw new Error(`archiveCards failed: ${res.status} ${await res.text()}`);
  return res.json();
}

export type ActivityEntry = {
  date: string;
  line: string;
  cardId: string;
  cardTitle: string;
  actor?: string;
};

export async function getActivity(
  boardId: string,
  limit = 50,
): Promise<{ boardId: string; entries: ActivityEntry[]; count: number }> {
  const res = await fetch(
    `/api/boards/${encodeURIComponent(boardId)}/activity?limit=${limit}`,
  );
  if (!res.ok) throw new Error(`getActivity failed: ${res.status}`);
  return res.json();
}

export type CardHistoryEntry = {
  sha: string;
  date: string;
  author: string;
  subject: string;
};

export async function getCardHistory(
  boardId: string,
  cardId: string,
  limit = 40,
): Promise<{ boardId: string; cardId: string; entries: CardHistoryEntry[]; count: number }> {
  const res = await fetch(
    `/api/boards/${encodeURIComponent(boardId)}/cards/${encodeURIComponent(cardId)}/history?limit=${limit}`,
  );
  if (!res.ok) throw new Error(`getCardHistory failed: ${res.status} ${await res.text()}`);
  return res.json();
}

export async function remapColumn(
  boardId: string,
  from: string,
  to: string,
): Promise<{ ok: boolean; remapped: string[]; sha?: string }> {
  const res = await fetch(
    `/api/boards/${encodeURIComponent(boardId)}/remap-column`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from, to }),
    },
  );
  if (!res.ok) throw new Error(`remapColumn failed: ${res.status} ${await res.text()}`);
  return res.json();
}
