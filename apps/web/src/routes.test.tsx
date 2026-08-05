import { describe, expect, test } from "bun:test";
import { createMemoryHistory } from "@tanstack/react-router";
import {
  formatAppPath,
  isSpaBoardPath,
  parseAppRoute,
  SETTINGS_SECTIONS,
} from "@kanbanly/core";
import {
  ROUTE_PATHS,
  createAppRouter,
  isPopAction,
  legacySlugReplace,
  navigateTo,
  readAppRoute,
} from "./routes.tsx";

/**
 * The routing migration's acceptance criteria.
 *
 * Two things have to stay true forever:
 *   1. Every URL the server is willing to serve matches a declared route, so
 *      the client never 404s on a path the server hands the SPA shell.
 *   2. The route the app acts on is exactly what packages/core's `parseAppRoute`
 *      says, because the server shares that parser via `isSpaBoardPath`.
 *
 * Everything below is a memory-history router, so this runs without a DOM.
 */

function routerAt(...entries: string[]) {
  return createAppRouter({
    shell: () => null,
    history: createMemoryHistory({ initialEntries: entries }),
  });
}

function matchedRouteId(path: string): string {
  const router = routerAt("/");
  const matches = router.matchRoutes(path, {});
  return matches[matches.length - 1]!.routeId;
}

/**
 * Every URL shape the app has ever answered to. The board/settings entries come
 * from nav.ts's doc comment and its regexes; `/board` and `/index.html` come
 * from `isSpaBoardPath`, which the server uses for its SPA fallback.
 */
const SERVED_URLS = [
  "/",
  "/board",
  "/index.html",
  "/b/backend",
  "/b/backend/c-a1b2",
  "/r/boards/b/backend",
  "/r/boards/b/backend/c-a1b2",
  "/settings",
  ...SETTINGS_SECTIONS.map((s) => `/settings/${s}`),
  "/settings/boards/backend",
  "/settings/r/boards/boards/backend",
];

describe("route tree", () => {
  test("declares a leaf for every URL the server serves", () => {
    for (const url of SERVED_URLS) {
      expect(isSpaBoardPath(url)).toBe(true);
      // Not the catch-all: each served shape has its own declared leaf.
      expect(matchedRouteId(url)).not.toBe("/$");
    }
  });

  test("the declared leaf is the shape you would expect", () => {
    expect(matchedRouteId("/")).toBe("/");
    expect(matchedRouteId("/b/backend")).toBe("/b/$boardId");
    expect(matchedRouteId("/b/backend/c-a1b2")).toBe("/b/$boardId/$cardId");
    expect(matchedRouteId("/r/boards/b/backend")).toBe(
      "/r/$remoteSlug/b/$boardId",
    );
    expect(matchedRouteId("/r/boards/b/backend/c-a1b2")).toBe(
      "/r/$remoteSlug/b/$boardId/$cardId",
    );
    expect(matchedRouteId("/settings")).toBe("/settings");
    expect(matchedRouteId("/settings/theme")).toBe("/settings/$section");
    expect(matchedRouteId("/settings/boards/backend")).toBe(
      "/settings/boards/$boardId",
    );
    expect(matchedRouteId("/settings/r/boards/boards/backend")).toBe(
      "/settings/r/$remoteSlug/boards/$boardId",
    );
  });

  test("nothing 404s — unrecognised paths fall to the catch-all, like nav.ts falls to home", () => {
    for (const url of [
      "/settings/r/local/boards",
      "/b/a/b/c",
      "/totally/unknown/deep/path",
      "/r/local",
    ]) {
      const matches = routerAt("/").matchRoutes(url, {});
      expect(matches.length).toBeGreaterThan(0);
      expect(matchedRouteId(url)).toBe("/$");
    }
  });

  test("an unknown settings section still matches the section leaf", () => {
    // The tree matches it structurally; nav.ts is what degrades the *meaning*
    // to the boards section (see readAppRoute below). That division is the
    // whole point of keeping parseAppRoute as the authority.
    expect(matchedRouteId("/settings/nonsense")).toBe("/settings/$section");
  });

  test("ROUTE_PATHS ends with the catch-all so matching stays exhaustive", () => {
    expect(ROUTE_PATHS[ROUTE_PATHS.length - 1]).toBe("/$");
  });
});

describe("readAppRoute", () => {
  test("agrees with parseAppRoute on every served URL", () => {
    for (const url of SERVED_URLS) {
      expect(readAppRoute(routerAt(url))).toEqual(parseAppRoute(url));
    }
  });

  test("agrees with parseAppRoute on the paths that fall through to home", () => {
    for (const url of ["/board", "/index.html", "/b/a/b/c", "/r/local"]) {
      expect(readAppRoute(routerAt(url))).toEqual(parseAppRoute(url));
      expect(parseAppRoute(url).kind).toBe("home");
    }
  });

  test("resolves the documented deep links", () => {
    expect(readAppRoute(routerAt("/r/boards/b/backend/c-a1b2"))).toEqual({
      kind: "board",
      remoteSlug: "boards",
      boardId: "backend",
      cardId: "c-a1b2",
    });
    expect(readAppRoute(routerAt("/settings/r/boards/boards/backend"))).toEqual({
      kind: "settings",
      section: "boards",
      remoteSlug: "boards",
      boardId: "backend",
    });
  });

  test("keeps nav.ts's hash-first rule for static hosts", () => {
    // nav.ts:280-284 — a hash that parses to something other than home wins
    // over the pathname. Only inbound; the app never writes hash URLs.
    expect(readAppRoute(routerAt("/#/r/local/b/backend"))).toEqual({
      kind: "board",
      remoteSlug: "local",
      boardId: "backend",
      cardId: null,
    });
  });

  test("an in-page anchor hash falls through to the pathname", () => {
    // The a11y skip link is href="#kb-main-board"; it must not be read as a route.
    expect(readAppRoute(routerAt("/b/backend#kb-main-board"))).toEqual({
      kind: "board",
      remoteSlug: null,
      boardId: "backend",
      cardId: null,
    });
  });

  test("degrades an unknown settings section to boards", () => {
    expect(readAppRoute(routerAt("/settings/nonsense"))).toEqual({
      kind: "settings",
      section: "boards",
      remoteSlug: null,
      boardId: null,
    });
  });

  test("decodes percent-encoded segments", () => {
    expect(readAppRoute(routerAt("/b/my%20board/c%2F1"))).toEqual({
      kind: "board",
      remoteSlug: null,
      boardId: "my board",
      cardId: "c/1",
    });
  });
});

describe("navigateTo", () => {
  test("writes exactly the string formatAppPath builds", () => {
    const router = routerAt("/");
    for (const route of [
      { kind: "board", boardId: "backend", cardId: null, remoteSlug: null },
      { kind: "board", boardId: "backend", cardId: "c-1", remoteSlug: null },
      { kind: "board", boardId: "backend", cardId: null, remoteSlug: "local" },
      { kind: "board", boardId: "backend", cardId: "c-1", remoteSlug: "local" },
      { kind: "settings", section: "theme", remoteSlug: null, boardId: null },
      { kind: "settings", section: "boards", remoteSlug: null, boardId: "b1" },
      { kind: "settings", section: "boards", remoteSlug: "local", boardId: "b1" },
      { kind: "home" },
    ] as const) {
      const href = navigateTo(router, route, { replace: true });
      expect(href).toBe(formatAppPath(route));
      expect(router.history.location.pathname).toBe(formatAppPath(route));
    }
  });

  test("round-trips: what it writes, readAppRoute reads back", () => {
    const router = routerAt("/");
    const route = {
      kind: "board",
      boardId: "backend",
      cardId: "c-a1b2",
      remoteSlug: "boards",
    } as const;
    navigateTo(router, route, { replace: true });
    expect(readAppRoute(router)).toEqual(route);
  });

  test("percent-encodes ids on the way out", () => {
    const router = routerAt("/");
    expect(
      navigateTo(
        router,
        { kind: "board", boardId: "my board", cardId: null, remoteSlug: null },
        { replace: true },
      ),
    ).toBe("/b/my%20board");
  });

  test("replace does not grow the history stack; push does", () => {
    const router = routerAt("/");
    const start = router.history.length;

    navigateTo(
      router,
      { kind: "board", boardId: "one", cardId: null, remoteSlug: null },
      { replace: true },
    );
    navigateTo(
      router,
      { kind: "board", boardId: "two", cardId: null, remoteSlug: null },
      { replace: true },
    );
    expect(router.history.length).toBe(start);

    // No `replace` — the portfolio / connect navigations, the only ones that
    // have ever added an entry.
    navigateTo(router, { kind: "home" });
    expect(router.history.length).toBe(start + 1);
  });

  test("back returns to the entry the push left behind", () => {
    const router = routerAt("/b/backend");
    navigateTo(router, { kind: "home" });
    expect(router.history.location.pathname).toBe("/");
    router.history.back();
    expect(router.history.location.pathname).toBe("/b/backend");
    expect(readAppRoute(router).kind).toBe("board");
  });

  test("skips the write when the pathname already matches, preserving the hash", () => {
    // Mirrors writeWindowAppRoute's short-circuit (nav.ts:334-335), which
    // compares pathname only. Without it the router would drop the skip-link
    // anchor on the next URL sync.
    const router = routerAt("/b/backend#kb-main-board");
    const before = router.history.length;
    navigateTo(
      router,
      { kind: "board", boardId: "backend", cardId: null, remoteSlug: null },
      { replace: true },
    );
    expect(router.history.location.hash).toBe("#kb-main-board");
    expect(router.history.length).toBe(before);
  });
});

describe("legacySlugReplace", () => {
  test("a slug means replace, no slug means push", () => {
    // The pre-router call passed the slug where nav.ts reads `options.replace`.
    // A string exposes String.prototype.replace (truthy) → replaceState; null
    // or undefined → pushState. Verified against the pre-router bundle.
    expect(legacySlugReplace("boards")).toBe(true);
    expect(legacySlugReplace("")).toBe(true);
    expect(legacySlugReplace(null)).toBe(false);
    expect(legacySlugReplace(undefined)).toBe(false);
  });

  test("with a slug configured, opening the portfolio adds no history entry", () => {
    const router = routerAt("/r/boards/b/backend");
    const before = router.history.length;
    navigateTo(
      router,
      { kind: "board", boardId: null, cardId: null, remoteSlug: null },
      { replace: legacySlugReplace("boards") },
    );
    expect(router.history.location.pathname).toBe("/");
    expect(router.history.length).toBe(before);
  });

  test("with no slug, it does add one", () => {
    const router = routerAt("/b/backend");
    const before = router.history.length;
    navigateTo(
      router,
      { kind: "board", boardId: null, cardId: null, remoteSlug: null },
      { replace: legacySlugReplace(null) },
    );
    expect(router.history.location.pathname).toBe("/");
    expect(router.history.length).toBe(before + 1);
  });
});

describe("isPopAction", () => {
  test("only browser-driven navigation counts", () => {
    expect(isPopAction({ type: "BACK" })).toBe(true);
    expect(isPopAction({ type: "FORWARD" })).toBe(true);
    expect(isPopAction({ type: "GO", index: -2 })).toBe(true);
    // The app's own URL writes; the old popstate listener never saw these.
    expect(isPopAction({ type: "PUSH" })).toBe(false);
    expect(isPopAction({ type: "REPLACE" })).toBe(false);
  });

  test("the history stream labels app writes and browser moves differently", () => {
    const router = routerAt("/b/backend");
    const seen: string[] = [];
    const unsubscribe = router.history.subscribe(({ action }) => {
      seen.push(`${action.type}:${isPopAction(action)}`);
    });

    navigateTo(
      router,
      { kind: "board", boardId: "other", cardId: null, remoteSlug: null },
      { replace: true },
    );
    navigateTo(router, { kind: "home" });
    router.history.back();
    unsubscribe();

    expect(seen).toEqual(["REPLACE:false", "PUSH:false", "BACK:true"]);
  });
});
