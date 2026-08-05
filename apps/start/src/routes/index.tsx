import { createFileRoute, redirect } from "@tanstack/react-router";
import * as svc from "../server/board-service.ts";

export const Route = createFileRoute("/")({
  loader: async () => {
    const { boards } = await svc.listBoards();
    const first = boards[0]?.id ?? "backend";
    throw redirect({ to: "/b/$boardId", params: { boardId: first } });
  },
  component: () => null,
});
