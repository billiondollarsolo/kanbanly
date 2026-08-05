/**
 * TanStack Start server functions — thin wrappers over board-service.
 */
import { createServerFn } from "@tanstack/react-start";
import * as svc from "./board-service.ts";

export const listBoardsFn = createServerFn({ method: "GET" }).handler(() =>
  svc.listBoards(),
);

export const getBoardFn = createServerFn({ method: "GET" })
  .inputValidator((d: { boardId: string }) => d)
  .handler(({ data }) => svc.getBoard(data.boardId));

export const createCardFn = createServerFn({ method: "POST" })
  .inputValidator((d: { boardId: string; title: string; column: string }) => d)
  .handler(({ data }) => svc.createCard(data.boardId, data.title, data.column));

export const moveCardFn = createServerFn({ method: "POST" })
  .inputValidator(
    (d: {
      boardId: string;
      cardId: string;
      column: string;
      order?: string;
    }) => d,
  )
  .handler(({ data }) =>
    svc.moveCard(data.boardId, data.cardId, data.column, data.order),
  );

export const updateCardFn = createServerFn({ method: "POST" })
  .inputValidator(
    (d: {
      boardId: string;
      cardId: string;
      patch: {
        title?: string;
        status?: string;
        labels?: string[];
        assignee?: string | null;
        due?: string | null;
        priority?: string | null;
        column?: string;
        order?: string;
      };
    }) => d,
  )
  .handler(({ data }) =>
    svc.updateCard(data.boardId, data.cardId, data.patch),
  );

export const archiveCardsFn = createServerFn({ method: "POST" })
  .inputValidator(
    (d: {
      boardId: string;
      cardIds?: string[];
      olderThanKeep?: number;
    }) => d,
  )
  .handler(({ data }) =>
    svc.archiveCards(data.boardId, {
      cardIds: data.cardIds,
      olderThanKeep: data.olderThanKeep,
    }),
  );

export const remapColumnFn = createServerFn({ method: "POST" })
  .inputValidator((d: { boardId: string; from: string; to: string }) => d)
  .handler(({ data }) =>
    svc.remapColumn(data.boardId, data.from, data.to),
  );

export const getSyncFn = createServerFn({ method: "GET" }).handler(() =>
  svc.getSync(),
);

export const retrySyncFn = createServerFn({ method: "POST" }).handler(() =>
  svc.retrySync(),
);

export const clearFreezeFn = createServerFn({ method: "POST" }).handler(() =>
  svc.clearFreeze(),
);

export const getActivityFn = createServerFn({ method: "GET" })
  .inputValidator((d: { boardId: string; limit?: number }) => d)
  .handler(({ data }) => svc.getActivity(data.boardId, data.limit ?? 100));

export const healthFn = createServerFn({ method: "GET" }).handler(() =>
  svc.health(),
);
