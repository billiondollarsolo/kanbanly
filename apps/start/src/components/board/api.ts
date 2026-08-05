/**
 * Board API — TanStack Start server functions (not HTTP to packages/server).
 */
import {
  archiveCardsFn,
  createCardFn,
  getActivityFn,
  getBoardFn,
  getSyncFn,
  listBoardsFn,
  moveCardFn,
  remapColumnFn,
  retrySyncFn,
  updateCardFn,
} from "../../server/board-fns.ts";

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
};

export type ActivityEntry = {
  date: string;
  line: string;
  cardId: string;
  cardTitle: string;
  actor?: string;
};

export async function listBoards(): Promise<{
  boards: BoardSummary[];
  sha: string | null;
}> {
  return listBoardsFn();
}

export async function getBoard(boardId: string): Promise<BoardDetail> {
  return getBoardFn({ data: { boardId } }) as Promise<BoardDetail>;
}

export async function createCard(
  boardId: string,
  title: string,
  column: string,
) {
  return createCardFn({ data: { boardId, title, column } });
}

export async function moveCard(
  boardId: string,
  cardId: string,
  payload: { column: string; order: string },
) {
  return moveCardFn({
    data: { boardId, cardId, column: payload.column, order: payload.order },
  });
}

export async function updateCard(
  boardId: string,
  cardId: string,
  patch: Record<string, unknown>,
) {
  return updateCardFn({
    data: { boardId, cardId, patch: patch as never },
  });
}

export async function archiveCards(
  boardId: string,
  body: { cardIds?: string[]; olderThanKeep?: number },
) {
  return archiveCardsFn({ data: { boardId, ...body } });
}

export async function remapColumn(boardId: string, from: string, to: string) {
  return remapColumnFn({ data: { boardId, from, to } });
}

export async function getSync(): Promise<SyncState> {
  return getSyncFn() as Promise<SyncState>;
}

export async function retrySync(): Promise<SyncState> {
  return retrySyncFn() as Promise<SyncState>;
}

export async function clearSyncFreeze(): Promise<SyncState> {
  const { clearFreezeFn } = await import("../../server/board-fns.ts");
  return (await clearFreezeFn()) as Promise<SyncState>;
}

export async function getActivity(boardId: string, limit = 50) {
  return getActivityFn({ data: { boardId, limit } });
}

/**
 * Prefer EventSource `/api/events` (Start SSE route → LiveHub).
 * Falls back to SHA polling if EventSource unavailable.
 */
export function subscribeBoardEvents(
  onEvent: (ev: { reason: string; sha: string }) => void,
  onError?: (err: Event) => void,
): () => void {
  if (typeof EventSource !== "undefined") {
    try {
      const es = new EventSource("/api/events");
      const handler = (msg: MessageEvent) => {
        try {
          const data = JSON.parse(String(msg.data)) as {
            reason: string;
            sha: string;
          };
          onEvent(data);
        } catch {
          /* ignore */
        }
      };
      es.addEventListener("board", handler as EventListener);
      es.onmessage = handler;
      if (onError) es.onerror = onError;
      return () => {
        es.removeEventListener("board", handler as EventListener);
        es.close();
      };
    } catch {
      /* fall through to poll */
    }
  }

  let lastSha = "";
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try {
      const { sha } = await listBoards();
      if (sha && sha !== lastSha) {
        const reason = lastSha === "" ? "hello" : "poll";
        lastSha = sha;
        onEvent({ reason, sha });
      }
    } catch {
      /* ignore */
    }
  };
  void tick();
  const id = setInterval(tick, 4000);
  return () => {
    stopped = true;
    clearInterval(id);
  };
}


