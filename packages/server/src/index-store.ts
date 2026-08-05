import type { Board, BoardSummary, Card, GitStorage } from "@kanbanly/core";
import { sortByOrder } from "@kanbanly/core";

/** Card as stored in the in-memory index. */
export type IndexedCard = {
  id: string;
  title: string;
  column: string;
  order: string;
  labels: string[];
  assignee?: string;
  due?: string;
  priority?: string;
  pr?: string;
  branch?: string;
  status: string;
  log: string[];
  updated: string;
  filename?: string;
  path?: string;
  /** True when column id is not in board.yml (also listed in quarantine). */
  unknownColumn?: boolean;
};

/** Cards that cannot join a normal column lane without user action. */
export type QuarantineItem = {
  kind: "parse_error" | "unknown_column";
  message: string;
  cardId?: string;
  title?: string;
  column?: string;
  filename?: string;
  path?: string;
};

/** Board entry in the index, with cards sorted by order per column. */
export type IndexedBoard = {
  id: string;
  path: string;
  board: Board;
  /** Cards grouped by column id, each group sorted by order then id. */
  cardsByColumn: Record<string, IndexedCard[]>;
  /** Flat list of all cards (sorted globally by order then id). */
  cards: IndexedCard[];
  /** Parse failures + unknown-column cards (board still renders). */
  quarantine: QuarantineItem[];
};

/** Snapshot for one connected remote / repo. */
export type RemoteIndex = {
  sha: string;
  boards: IndexedBoard[];
  /** Flat card list across all boards (for convenience). */
  cards: IndexedCard[];
};

export type RebuildResult = {
  index: RemoteIndex;
  /** True when a full re-parse ran. */
  rebuilt: boolean;
};

function toIndexedCard(card: Card, ref?: { filename?: string; path?: string }): IndexedCard {
  const fm = card.frontmatter;
  return {
    id: fm.id,
    title: fm.title,
    column: fm.column,
    order: fm.order,
    labels: fm.labels ?? [],
    assignee: fm.assignee,
    due: fm.due,
    priority: fm.priority,
    pr: fm.pr,
    branch: fm.branch,
    status: card.status,
    log: card.log,
    updated: fm.updated,
    filename: ref?.filename,
    path: ref?.path,
  };
}

/**
 * In-memory board index keyed by remote (or local path key).
 * Rebuilds only when the HEAD SHA changes.
 * Exposes a parse-call counter so tests can assert zero work on unchanged SHA.
 */
export class BoardIndexStore {
  private indexes = new Map<string, RemoteIndex>();
  /** Number of times parseBoard/parseCard work was performed (via storage reads). */
  parseCallCount = 0;
  /** Number of full rebuilds that actually ran. */
  rebuildCount = 0;

  get(remoteKey: string): RemoteIndex | undefined {
    return this.indexes.get(remoteKey);
  }

  /** Drop a remote from the store. */
  delete(remoteKey: string): void {
    this.indexes.delete(remoteKey);
  }

  /** Reset counters (for tests). */
  resetCounters(): void {
    this.parseCallCount = 0;
    this.rebuildCount = 0;
  }

  /**
   * Ensure the index for `remoteKey` matches current HEAD.
   * If SHA is unchanged, returns cached index with zero parse work.
   */
  async ensure(
    remoteKey: string,
    storage: GitStorage,
  ): Promise<RebuildResult> {
    const sha = storage.headSha();
    const existing = this.indexes.get(remoteKey);
    if (existing && existing.sha === sha && sha !== "") {
      return { index: existing, rebuilt: false };
    }
    const index = await this.rebuild(remoteKey, storage, sha);
    return { index, rebuilt: true };
  }

  /**
   * Force a full rebuild from storage, regardless of SHA.
   */
  async rebuild(
    remoteKey: string,
    storage: GitStorage,
    knownSha?: string,
  ): Promise<RemoteIndex> {
    const sha = knownSha ?? storage.headSha();
    const boardsList = await storage.listBoards();
    this.parseCallCount++; // listBoards walks the tree

    const summaries: BoardSummary[] = boardsList.ok ? boardsList.value : [];
    const indexedBoards: IndexedBoard[] = [];
    const allCards: IndexedCard[] = [];

    for (const summary of summaries) {
      this.parseCallCount++; // readBoard → parseBoard
      const boardRes = await storage.readBoard(summary.id);
      if (!boardRes.ok) continue;
      const board = boardRes.value;

      const listed = await storage.listCards(summary.id);
      const refs = listed.ok ? listed.value : [];
      const cards: IndexedCard[] = [];
      const quarantine: QuarantineItem[] = [];
      const knownColumns = new Set(board.columns.map((c) => c.id));

      // Parallel card reads — sequential await is too slow at 2k+ cards (US-13).
      this.parseCallCount += refs.length;
      const cardResults = await Promise.all(
        refs.map(async (ref) => ({ ref, cardRes: await storage.readCard(summary.id, ref.id) })),
      );
      for (const { ref, cardRes } of cardResults) {
        if (!cardRes.ok) {
          quarantine.push({
            kind: "parse_error",
            message:
              cardRes.error.kind === "io"
                ? cardRes.error.message
                : cardRes.error.kind === "not_found"
                  ? `not found: ${ref.id}`
                  : String(cardRes.error),
            cardId: ref.id,
            filename: ref.filename,
            path: ref.path,
          });
          continue;
        }
        const indexed = toIndexedCard(cardRes.value, ref);
        if (!knownColumns.has(indexed.column)) {
          indexed.unknownColumn = true;
          quarantine.push({
            kind: "unknown_column",
            message: `Unknown column: ${indexed.column}`,
            cardId: indexed.id,
            title: indexed.title,
            column: indexed.column,
            filename: ref.filename,
            path: ref.path,
          });
        }
        cards.push(indexed);
      }

      // Sort flat list by order then id
      sortByOrder(cards);

      // Group by column, preserving sort order within each column
      const cardsByColumn: Record<string, IndexedCard[]> = {};
      for (const col of board.columns) {
        cardsByColumn[col.id] = [];
      }
      for (const card of cards) {
        // Unknown columns get their own bucket (visible as quarantine, not normal lanes)
        if (card.unknownColumn) continue;
        const bucket = cardsByColumn[card.column] ?? (cardsByColumn[card.column] = []);
        bucket.push(card);
      }
      // Each column group is already in global order order; re-sort for safety
      for (const colId of Object.keys(cardsByColumn)) {
        sortByOrder(cardsByColumn[colId]!);
      }

      const entry: IndexedBoard = {
        id: summary.id,
        path: summary.path,
        board,
        cardsByColumn,
        cards,
        quarantine,
      };
      indexedBoards.push(entry);
      allCards.push(...cards);
    }

    const index: RemoteIndex = {
      sha,
      boards: indexedBoards,
      cards: allCards,
    };
    this.indexes.set(remoteKey, index);
    this.rebuildCount++;
    return index;
  }

  /** Find a board by id within a remote index. */
  getBoard(remoteKey: string, boardId: string): IndexedBoard | undefined {
    const idx = this.indexes.get(remoteKey);
    if (!idx) return undefined;
    return idx.boards.find((b) => b.id === boardId || b.path === boardId);
  }
}
