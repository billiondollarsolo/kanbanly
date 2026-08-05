import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { memo } from "react";
import { createRoot } from "react-dom/client";
import { BoardApp } from "./Board.tsx";
import { createQueryClient } from "./queries.ts";
import { createAppRouter } from "./routes.tsx";
import "./styles.css";

const root = document.getElementById("root");
if (!root) {
  throw new Error("#root missing");
}

// One client for the life of the tab. Its defaults (staleTime, retry,
// refetch-on-focus) live next to the query definitions in queries.ts.
const queryClient = createQueryClient();

// The router re-renders its root route on every location change, including the
// replace-mode URL syncs the app performs on nearly every state change. BoardApp
// takes no props and derives its view from its own state, so memoizing it keeps
// those syncs as free as the bare history.replaceState calls they replaced.
const AppShell = memo(BoardApp);

const router = createAppRouter({ shell: AppShell });

// The query provider stays outside the router: BoardApp is rendered by the
// router's root route and needs both contexts.
createRoot(root).render(
  <QueryClientProvider client={queryClient}>
    <RouterProvider router={router} />
  </QueryClientProvider>,
);
