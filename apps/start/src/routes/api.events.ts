/**
 * SSE live updates for TanStack Start (same LiveHub as packages/server).
 */
import { createFileRoute } from "@tanstack/react-router";
import { getSession } from "../server/session.ts";

export const Route = createFileRoute("/api/events")({
  server: {
    handlers: {
      GET: async () => {
        const s = await getSession();
        return s.live.subscribe();
      },
    },
  },
});
