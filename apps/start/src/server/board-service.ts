/**
 * Plain async board service (no Start ALS). Used by createServerFn handlers + tests.
 */
import {
  buildActivityFeed,
  orderAfter,
  orderForDrop,
  orderInitial,
} from "@kanbanly/core";
import type { IndexedBoard } from "@kanbanly/server";
import { afterWrite, getSession } from "./session.ts";

function boardPayload(board: IndexedBoard) {
  const unknownByColumn: Record<string, typeof board.cards> = {};
  for (const c of board.cards) {
    if (!c.unknownColumn) continue;
    (unknownByColumn[c.column] ??= []).push(c);
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

export async function listBoards() {
  const s = await getSession();
  await s.indexStore.ensure(s.connected.remoteKey, s.connected.storage);
  const idx = s.indexStore.get(s.connected.remoteKey);
  const boards = (idx?.boards ?? []).map((b) => ({
    id: b.id,
    path: b.path,
    columns: b.board.columns.map((c) => c.id),
    cardCount: b.cards.length,
  }));
  return { boards, sha: idx?.sha ?? null };
}

export async function getBoard(boardId: string) {
  const s = await getSession();
  await s.indexStore.ensure(s.connected.remoteKey, s.connected.storage);
  const board = s.indexStore.getBoard(s.connected.remoteKey, boardId);
  if (!board) throw new Error(`Board not found: ${boardId}`);
  return boardPayload(board);
}

export async function createCard(boardId: string, title: string, column: string) {
  const s = await getSession();
  await s.indexStore.ensure(s.connected.remoteKey, s.connected.storage);
  const board = s.indexStore.getBoard(s.connected.remoteKey, boardId);
  if (!board) throw new Error(`Board not found: ${boardId}`);
  const colCards = board.cardsByColumn[column] ?? [];
  const last = colCards.length > 0 ? colCards[colCards.length - 1]!.order : null;
  const order = orderAfter(last) || orderInitial();
  const created = await s.connected.storage.createCard(
    boardId,
    title,
    column,
    order,
    { actor: "human" },
  );
  if (!created.ok) throw new Error(JSON.stringify(created.error));
  await afterWrite(s, created.value.sha);
  return {
    ok: true as const,
    card: {
      id: created.value.card.frontmatter.id,
      title: created.value.card.frontmatter.title,
      column: created.value.card.frontmatter.column,
      order: created.value.card.frontmatter.order,
    },
    sha: created.value.sha,
    sync: s.pushQueue.getState(),
  };
}

export async function moveCard(
  boardId: string,
  cardId: string,
  column: string,
  order?: string,
) {
  const s = await getSession();
  await s.indexStore.ensure(s.connected.remoteKey, s.connected.storage);
  const board = s.indexStore.getBoard(s.connected.remoteKey, boardId);
  if (!board) throw new Error(`Board not found: ${boardId}`);
  let newOrder = order;
  if (!newOrder) {
    const colCards = board.cardsByColumn[column] ?? [];
    newOrder = orderForDrop(
      colCards.map((c) => ({ id: c.id, order: c.order })),
      cardId,
      colCards.length,
    );
  }
  const moved = await s.connected.storage.moveCard(
    boardId,
    cardId,
    column,
    newOrder,
    { actor: "human" },
  );
  if (!moved.ok) throw new Error(JSON.stringify(moved.error));
  await afterWrite(s, moved.value.sha);
  return {
    ok: true as const,
    sha: moved.value.sha,
    column,
    order: newOrder,
    sync: s.pushQueue.getState(),
  };
}

export async function updateCard(
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
) {
  const s = await getSession();
  const updated = await s.connected.storage.updateCard(boardId, cardId, patch, {
    actor: "human",
  });
  if (!updated.ok) throw new Error(JSON.stringify(updated.error));
  await afterWrite(s, updated.value.sha);
  const c = updated.value.card;
  return {
    ok: true as const,
    sha: updated.value.sha,
    card: {
      id: c.frontmatter.id,
      title: c.frontmatter.title,
      column: c.frontmatter.column,
      order: c.frontmatter.order,
      labels: c.frontmatter.labels ?? [],
      assignee: c.frontmatter.assignee,
      due: c.frontmatter.due,
      priority: c.frontmatter.priority,
      status: c.status,
      log: c.log,
      updated: c.frontmatter.updated,
    },
    sync: s.pushQueue.getState(),
  };
}

export async function archiveCards(
  boardId: string,
  opts: { cardIds?: string[]; olderThanKeep?: number },
) {
  const s = await getSession();
  await s.indexStore.ensure(s.connected.remoteKey, s.connected.storage);
  const board = s.indexStore.getBoard(s.connected.remoteKey, boardId);
  if (!board) throw new Error(`Board not found: ${boardId}`);
  let ids = opts.cardIds ?? [];
  if (ids.length === 0 && opts.olderThanKeep !== undefined) {
    const keep = Math.max(0, opts.olderThanKeep);
    const done = (board.cardsByColumn["done"] ?? [])
      .slice()
      .sort((a, b) =>
        a.updated < b.updated ? 1 : a.updated > b.updated ? -1 : 0,
      );
    ids = done.slice(keep).map((c) => c.id);
  }
  if (ids.length === 0) throw new Error("No cards to archive");
  const archived = await s.connected.storage.archiveCards(boardId, ids);
  if (!archived.ok) throw new Error(JSON.stringify(archived.error));
  await afterWrite(s, archived.value.sha);
  return {
    ok: true as const,
    sha: archived.value.sha,
    archived: archived.value.archived,
    sync: s.pushQueue.getState(),
  };
}

export async function remapColumn(boardId: string, from: string, to: string) {
  const s = await getSession();
  await s.indexStore.ensure(s.connected.remoteKey, s.connected.storage);
  const board = s.indexStore.getBoard(s.connected.remoteKey, boardId);
  if (!board) throw new Error(`Board not found: ${boardId}`);
  const known = new Set(board.board.columns.map((c) => c.id));
  if (!known.has(to)) throw new Error(`Unknown target column: ${to}`);
  const toRemap = board.cards.filter(
    (c) => c.unknownColumn && c.column === from,
  );
  const remapped: string[] = [];
  let lastSha: string | undefined;
  for (const card of toRemap) {
    const updated = await s.connected.storage.updateCard(
      boardId,
      card.id,
      { column: to },
      {
        actor: "human",
        message: `chore(board): remap ${card.id} ${from} → ${to}`,
      },
    );
    if (updated.ok) {
      remapped.push(card.id);
      lastSha = updated.value.sha;
    }
  }
  await afterWrite(s, lastSha);
  return { ok: true as const, remapped, sha: lastSha, from, to };
}

export async function getSync() {
  const s = await getSession();
  return s.pushQueue.getState();
}

export async function retrySync() {
  const s = await getSession();
  return s.pushQueue.flush();
}

export async function clearFreeze() {
  const s = await getSession();
  s.pushQueue.clearFreeze();
  return s.pushQueue.getState();
}

export async function getActivity(boardId: string, limit = 100) {
  const s = await getSession();
  await s.indexStore.ensure(s.connected.remoteKey, s.connected.storage);
  const board = s.indexStore.getBoard(s.connected.remoteKey, boardId);
  if (!board) throw new Error(`Board not found: ${boardId}`);
  const entries = buildActivityFeed(
    board.cards.map((c) => ({ id: c.id, title: c.title, log: c.log })),
    { limit },
  );
  return { boardId, entries, count: entries.length };
}

export async function health() {
  const s = await getSession();
  return {
    ok: true as const,
    product: "kanbanly-start",
    repo: s.connected.path,
    sha: s.live.getLastSha(),
    sync: s.pushQueue.getState(),
  };
}
