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
  title?: string;
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
  /** Human title from board.yml when set */
  title?: string;
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

/** Append a column to board.yml (Trello-style add list). */
export async function addColumn(
  boardId: string,
  name: string,
  id?: string,
): Promise<{
  ok: boolean;
  column: BoardColumn;
  columns: BoardColumn[];
  sha?: string;
  sync?: SyncState | null;
}> {
  const res = await fetch(
    `/api/boards/${encodeURIComponent(boardId)}/columns`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, id }),
    },
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`addColumn failed: ${res.status} ${err}`);
  }
  return res.json();
}

export async function renameColumn(
  boardId: string,
  columnId: string,
  name: string,
): Promise<{
  ok: boolean;
  column: BoardColumn;
  columns: BoardColumn[];
  sha?: string;
  sync?: SyncState | null;
}> {
  const res = await fetch(
    `/api/boards/${encodeURIComponent(boardId)}/columns/${encodeURIComponent(columnId)}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    },
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`renameColumn failed: ${res.status} ${err}`);
  }
  return res.json();
}

export async function reorderColumns(
  boardId: string,
  order: string[],
): Promise<{
  ok: boolean;
  columns: BoardColumn[];
  sha?: string;
  sync?: SyncState | null;
}> {
  const res = await fetch(
    `/api/boards/${encodeURIComponent(boardId)}/columns`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ order }),
    },
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`reorderColumns failed: ${res.status} ${err}`);
  }
  return res.json();
}

/** Delete a list. If it has cards, pass moveTo column id or "archive". */
export async function deleteColumn(
  boardId: string,
  columnId: string,
  moveTo?: string,
): Promise<{
  ok: boolean;
  columns: BoardColumn[];
  moved?: number;
  archived?: number;
  sha?: string;
  sync?: SyncState | null;
}> {
  const res = await fetch(
    `/api/boards/${encodeURIComponent(boardId)}/columns/${encodeURIComponent(columnId)}`,
    {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(moveTo ? { moveTo } : {}),
    },
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`deleteColumn failed: ${res.status} ${err}`);
  }
  return res.json();
}

/** Create a layout-A board subdirectory. */
export async function createBoard(
  name: string,
  options?: {
    id?: string;
    boardDir?: string;
    credentialId?: string | null;
    remoteSlug?: string;
  },
): Promise<{
  ok: boolean;
  boardId: string;
  remoteSlug?: string | null;
  sha?: string;
  sync?: SyncState | null;
}> {
  const res = await fetch(`/api/boards`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name,
      id: options?.id ?? options?.boardDir,
      boardDir: options?.boardDir,
      credentialId: options?.credentialId,
      remoteSlug: options?.remoteSlug,
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`createBoard failed: ${res.status} ${err}`);
  }
  return res.json();
}

export type WorkspaceCredential = {
  id: string;
  label: string;
  username: string;
  updatedAt: string;
};

export type WorkspaceConnection = {
  id: string;
  label: string;
  localPath: string;
  remoteUrl: string | null;
  defaultCredentialId: string | null;
  active: boolean;
  boardCount: number;
  cardCount: number;
  sha: string;
};

export type WorkspaceBoard = {
  key: string;
  boardId: string;
  boardDir: string;
  label: string;
  cardCount: number;
  remoteSlug: string;
  remoteLabel: string;
  localPath: string;
  remoteUrl: string | null;
  credentialId: string | null;
  connectionDefaultCredentialId: string | null;
  resolvedCredentialId: string | null;
  activeRemote: boolean;
  sha: string;
};

export type WorkspaceSnapshot = {
  connections: WorkspaceConnection[];
  boards: WorkspaceBoard[];
  credentials: WorkspaceCredential[];
  activeRemote: string | null;
};

export async function getWorkspace(): Promise<WorkspaceSnapshot> {
  const res = await fetch("/api/workspace");
  if (!res.ok) throw new Error(`getWorkspace failed: ${res.status}`);
  return res.json();
}

export async function patchBoardBinding(input: {
  remoteSlug: string;
  boardId: string;
  fromRemoteSlug?: string;
  credentialId?: string | null;
  label?: string;
  boardDir?: string;
}): Promise<{ ok: boolean }> {
  const res = await fetch("/api/workspace/boards", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`patchBoardBinding failed: ${res.status}`);
  return res.json();
}

export async function patchConnection(input: {
  id: string;
  defaultCredentialId?: string | null;
  label?: string;
}): Promise<{ ok: boolean }> {
  const res = await fetch("/api/workspace/connections", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`patchConnection failed: ${res.status}`);
  return res.json();
}

export async function listCredentialBook(): Promise<{
  credentials: WorkspaceCredential[];
}> {
  const res = await fetch("/api/credentials/book");
  if (!res.ok) throw new Error(`listCredentialBook failed: ${res.status}`);
  return res.json();
}

export async function upsertCredentialBook(input: {
  id?: string;
  label: string;
  username?: string;
  token?: string;
}): Promise<{ ok: boolean; credential: WorkspaceCredential }> {
  const res = await fetch("/api/credentials/book", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`upsertCredentialBook failed: ${res.status} ${err}`);
  }
  return res.json();
}

export async function deleteCredentialBook(id: string): Promise<void> {
  const res = await fetch(
    `/api/credentials/book/${encodeURIComponent(id)}`,
    { method: "DELETE" },
  );
  if (!res.ok) throw new Error(`deleteCredentialBook failed: ${res.status}`);
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

export type ProjectCommit = {
  sha: string;
  date: string;
  author: string;
  subject: string;
  url?: string | null;
  /** Board card ids mentioned in the subject (when present on this board). */
  cardIds?: string[];
};

export type PortfolioTile = {
  boardId: string;
  title: string;
  cardCount: number;
  columnCounts: Record<string, number>;
  p0Count: number;
  doingCount: number;
  blockedCount: number;
  readyCount?: number;
  lastUpdated: string | null;
  lastActivity: {
    date: string;
    line: string;
    actor?: string;
    cardId: string;
    cardTitle: string;
  } | null;
  lastAgent: string | null;
  staleDoingCount: number;
  codeBound: boolean;
  wipDoing?: { count: number; limit: number; over: boolean };
  health?: string;
  velocity?: {
    windowDays: number;
    done7d: number;
    review7d: number;
    logEvents7d: number;
    agentEvents7d: number;
    pulseAgeHours: number | null;
    codeCommits7d: number | null;
    codeCommits24h: number | null;
  };
};

export type PortfolioResponse = {
  tiles: PortfolioTile[];
  activity: Array<{
    date: string;
    line: string;
    actor?: string;
    cardId: string;
    cardTitle: string;
    boardId: string;
    boardTitle: string;
  }>;
  p0Total: number;
  staleTotal: number;
  velocity?: {
    windowDays: number;
    done7d: number;
    logEvents7d: number;
    agentEvents7d: number;
    codeCommits7d: number;
    codeCommits24h: number;
  };
  sha: string | null;
};

export async function getPortfolio(): Promise<PortfolioResponse> {
  const res = await fetch("/api/portfolio");
  if (!res.ok) throw new Error(`getPortfolio failed: ${res.status}`);
  return res.json();
}

export type FleetHealthResponse = {
  ok: boolean;
  generatedAt: string;
  boardCount: number;
  issueCount: number;
  highCount: number;
  issues: Array<{
    kind: string;
    severity: string;
    boardId: string;
    boardTitle: string;
    message: string;
    cardId?: string;
  }>;
  summary: {
    p0Total: number;
    staleTotal: number;
    wipOverBoards: number;
    silentBoards: number;
    blockedTotal: number;
  };
  sha: string | null;
};

/** Unattended fleet monitor: high-severity issues across boards. */
export async function getFleetHealth(options?: {
  staleHours?: number;
  silentHours?: number;
}): Promise<FleetHealthResponse> {
  const q = new URLSearchParams();
  if (options?.staleHours != null) q.set("staleHours", String(options.staleHours));
  if (options?.silentHours != null) {
    q.set("silentHours", String(options.silentHours));
  }
  const qs = q.toString();
  const res = await fetch(`/api/fleet-health${qs ? `?${qs}` : ""}`);
  if (!res.ok) throw new Error(`getFleetHealth failed: ${res.status}`);
  return res.json();
}

export type CodeHistoryResponse = {
  boardId: string;
  source: "code";
  bound: boolean;
  binding: { path?: string; remote?: string } | null;
  codePath: string | null;
  error: string | null;
  commits: ProjectCommit[];
  count: number;
};

/** Project/code-repo commits (not boards-repo history). */
export async function getCodeHistory(
  boardId: string,
  limit = 50,
): Promise<CodeHistoryResponse> {
  const res = await fetch(
    `/api/boards/${encodeURIComponent(boardId)}/code-history?limit=${limit}`,
  );
  if (!res.ok) throw new Error(`getCodeHistory failed: ${res.status}`);
  return res.json();
}

export async function setCodeBinding(
  boardId: string,
  body: {
    path?: string | null;
    remote?: string | null;
    url?: string | null;
    clear?: boolean;
    token?: string;
    username?: string;
    credentialId?: string;
  },
): Promise<{
  ok: boolean;
  settings: Record<string, unknown>;
  sha?: string;
  source?: {
    path: string;
    remote: string | null;
    cloned: boolean;
    fetched: boolean;
  } | null;
  history?: {
    bound: boolean;
    commits: ProjectCommit[];
    count: number;
    error: string | null;
    codePath: string | null;
  } | null;
}> {
  const res = await fetch(
    `/api/boards/${encodeURIComponent(boardId)}/code-binding`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) {
    throw new Error(`setCodeBinding failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

/** Connect/bind a source code remote (clone + auth) for a board. */
export async function connectCodeSource(
  boardId: string,
  body: {
    url?: string;
    remote?: string;
    path?: string;
    token?: string;
    username?: string;
    credentialId?: string;
  },
): Promise<{
  ok: boolean;
  settings: Record<string, unknown>;
  source?: {
    path: string;
    remote: string | null;
    cloned: boolean;
    fetched: boolean;
  } | null;
  history?: {
    bound: boolean;
    commits: ProjectCommit[];
    count: number;
    error: string | null;
    codePath: string | null;
  } | null;
}> {
  const res = await fetch(
    `/api/boards/${encodeURIComponent(boardId)}/code-source`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) {
    throw new Error(
      `connectCodeSource failed: ${res.status} ${await res.text()}`,
    );
  }
  return res.json();
}

export async function getBoardNotes(
  boardId: string,
): Promise<{ boardId: string; body: string; path: string; exists: boolean }> {
  const res = await fetch(
    `/api/boards/${encodeURIComponent(boardId)}/notes`,
  );
  if (!res.ok) throw new Error(`getBoardNotes failed: ${res.status}`);
  return res.json();
}

export async function putBoardNotes(
  boardId: string,
  body: string,
): Promise<{ ok: boolean; path: string; sha?: string }> {
  const res = await fetch(
    `/api/boards/${encodeURIComponent(boardId)}/notes`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body }),
    },
  );
  if (!res.ok) {
    throw new Error(`putBoardNotes failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

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
