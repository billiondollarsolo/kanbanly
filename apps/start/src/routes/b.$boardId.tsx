import { createFileRoute } from "@tanstack/react-router";
import { BoardApp } from "../components/board/Board.tsx";
import * as svc from "../server/board-service.ts";

export const Route = createFileRoute("/b/$boardId")({
  loader: async ({ params }) => {
    const [list, board] = await Promise.all([
      svc.listBoards(),
      svc.getBoard(params.boardId),
    ]);
    return { list, board, boardId: params.boardId };
  },
  component: BoardPage,
  errorComponent: ({ error }) => (
    <main style={{ padding: "2rem", fontFamily: "system-ui" }}>
      <h1>Board error</h1>
      <pre>{error.message}</pre>
      <p>
        Set <code>KANBANLY_REPO</code> to a boards git repository, or run from
        the monorepo root so <code>fixtures/boards-layout-a</code> resolves.
      </p>
    </main>
  ),
});

function BoardPage() {
  // BoardApp loads data via server functions (createServerFn wrappers).
  const { boardId } = Route.useParams();
  return (
    <div data-start-route="board" data-board-id={boardId}>
      <BoardApp />
    </div>
  );
}
