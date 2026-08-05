import type { Board } from "../board.ts";
import type { Card } from "../card.ts";

export type StorageError =
  | { kind: "not_found"; path: string }
  | { kind: "conflict"; message: string; files?: string[] }
  | { kind: "cas_failed"; message: string; etag?: string }
  | { kind: "io"; message: string; cause?: unknown };

export type StorageResult<T> = { ok: true; value: T } | { ok: false; error: StorageError };

export type BoardSummary = {
  id: string;
  path: string;
};

export type CardRef = {
  id: string;
  filename: string;
  path: string;
};

/**
 * Storage interface shared by Git and S3 adapters.
 */
export interface BoardStorage {
  listBoards(): Promise<StorageResult<BoardSummary[]>>;
  readBoard(boardId: string): Promise<StorageResult<Board>>;
  listCards(boardId: string): Promise<StorageResult<CardRef[]>>;
  readCard(boardId: string, cardId: string): Promise<StorageResult<Card>>;
  writeCard(
    boardId: string,
    card: Card,
    options?: { message?: string; expectedEtag?: string },
  ): Promise<StorageResult<{ sha?: string; etag?: string }>>;
  moveCard(
    boardId: string,
    cardId: string,
    toColumn: string,
    newOrder: string,
    options?: { actor?: string; message?: string },
  ): Promise<StorageResult<{ sha?: string; etag?: string }>>;
}
