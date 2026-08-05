/**
 * TanStack Router adoption for apps/web.
 *
 * ## Why the router does not own the URL *grammar*
 *
 * The grammar lives in `packages/core/src/nav.ts` and is shared with the
 * server: `packages/server/src/app.ts` calls `isSpaBoardPath` to decide which
 * paths get the SPA shell, and `parseAppRoute`/`formatAppPath` are locked by
 * tests in packages/core and packages/server. If this app matched and built
 * URLs with its own parser, the client and the server could drift — a path the
 * server serves but the client reads differently, or vice versa.
 *
 * So the split is:
 *   - TanStack Router owns *history*: the browser History integration, the
 *     location store, back/forward, and the match pass that guarantees no
 *     client-side 404 on anything the server is willing to serve.
 *   - `nav.ts` stays the single parse/format authority. `readAppRoute` feeds
 *     the router's own location into `readWindowAppRoute`, and `navigateTo`
 *     hands `formatAppPath`'s exact string to `router.navigate`.
 *
 * `ROUTE_PATHS` below is therefore a *declaration* of the URL surface, checked
 * against nav.ts by routes.test.ts so the two can never silently diverge.
 *
 * ## Behaviour this deliberately preserves
 *
 *  - `navigateTo` short-circuits on pathname equality, exactly like
 *    `writeWindowAppRoute` does (nav.ts:334-335). Without it the router would
 *    also rewrite the *hash*, so the `#kb-main-board` skip-link anchor would be
 *    stripped on the next URL sync.
 *  - Every navigation passes `resetScroll: false`. TanStack installs an
 *    `onRendered` subscriber that calls `scrollTo(0, 0)` on navigation whether
 *    or not `scrollRestoration` is enabled; the old `history.replaceState`
 *    calls never scrolled, so it is turned off per-navigation. Note we do *not*
 *    set the `scrollRestoration` option: a truthy value there would flip
 *    `history.scrollRestoration` to "manual" and disable the browser's native
 *    back/forward scroll restore, which is a behaviour change in the other
 *    direction.
 *  - `usePopNavigation` fires only for BACK / FORWARD / GO. The app writes the
 *    URL on nearly every state change, and the old listener pair
 *    (popstate + hashchange) never saw those writes because `replaceState`
 *    does not emit popstate. Filtering on the history action reproduces that
 *    exactly; subscribing to the location instead would re-enter on every
 *    self-write.
 */
import {
  Outlet,
  createRootRoute,
  createRoute,
  createRouter,
  useRouter,
} from "@tanstack/react-router";
import type { AnyRouter, RouterHistory } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, type ComponentType } from "react";
import {
  formatAppPath,
  readWindowAppRoute,
  type AppRoute,
} from "@kanbanly/core";

/**
 * Every path shape the app answers to, in the order the tree declares them.
 *
 * These mirror `parseAppRoute` (packages/core/src/nav.ts:110-190) and the
 * server's `isSpaBoardPath` (nav.ts:347-362). `/board` and `/index.html` are in
 * the list because the server serves them even though nav.ts reads them as
 * home. `/$` is the catch-all that keeps anything else — `/settings/nonsense`,
 * `/b/a/b/c` — rendering the app instead of a router not-found, which is what
 * nav.ts's fall-through to `{kind:"home"}` does today.
 */
export const ROUTE_PATHS = [
  "/",
  "/board",
  "/index.html",
  "/b/$boardId",
  "/b/$boardId/$cardId",
  "/r/$remoteSlug/b/$boardId",
  "/r/$remoteSlug/b/$boardId/$cardId",
  "/settings",
  "/settings/$section",
  "/settings/boards/$boardId",
  "/settings/r/$remoteSlug/boards/$boardId",
  "/$",
] as const;

/**
 * Build the code-based route tree. Code-based, not file-based, so `bun build`
 * stays a single bundling step with no codegen.
 *
 * The whole app is one shell component mounted at the root route: every URL
 * renders the same `<BoardApp/>`, and which board/card/section is showing is
 * derived from the location rather than from which component is mounted. The
 * leaves carry no component on purpose — mounting the shell per-leaf would
 * unmount and remount it (losing ~85 pieces of local state) every time the URL
 * shape changed, e.g. from `/b/x` to `/b/x/c-1`.
 */
export function createAppRouteTree(Shell: ComponentType) {
  const rootRoute = createRootRoute({
    component: function AppShellRoute() {
      return (
        <>
          <Shell />
          <Outlet />
        </>
      );
    },
  });

  const children = ROUTE_PATHS.map((path) =>
    createRoute({ getParentRoute: () => rootRoute, path }),
  );

  return rootRoute.addChildren(children);
}

/**
 * Create the app router.
 *
 * `Shell` is memoized by the caller so the root component re-rendering on a
 * location change does not re-render the 3.5k-line app; the app tracks the
 * route through its own state, as it did before the router existed.
 */
export function createAppRouter(options: {
  shell: ComponentType;
  history?: RouterHistory;
}) {
  return createRouter({
    routeTree: createAppRouteTree(options.shell),
    ...(options.history ? { history: options.history } : {}),
    // Matching is exhaustive (see the `/$` leaf), so this only guards against a
    // future edit dropping the catch-all.
    defaultNotFoundComponent: () => null,
  });
}

/**
 * `SubscriberArgs` is not exported by @tanstack/history, and `AnyRouter` widens
 * `history` enough to lose it, so derive it from the subscribe signature.
 */
type HistorySubscriberArgs = Parameters<
  Parameters<RouterHistory["subscribe"]>[0]
>[0];

/** The router's history location, in the `window.location` shape nav.ts wants. */
function historyLocation(router: AnyRouter): { pathname: string; hash: string } {
  const loc = router.history.location;
  return { pathname: loc.pathname, hash: loc.hash };
}

/**
 * Parse the router's current location with nav.ts.
 *
 * Reads `router.history.location` rather than `router.state.location`: the
 * former keeps the raw `#…` hash prefix and is updated synchronously by
 * push/replace/pop, which is what `readWindowAppRoute`'s hash-first rule
 * (nav.ts:280-284) expects.
 */
export function readAppRoute(router: AnyRouter): AppRoute {
  return readWindowAppRoute(() => historyLocation(router));
}

/**
 * Write an app route into history.
 *
 * Returns the path written (or the current one when the write was skipped), so
 * callers can assert on it the way `writeWindowAppRoute` allowed.
 */
export function navigateTo(
  router: AnyRouter,
  route: AppRoute,
  options?: { replace?: boolean },
): string {
  const href = formatAppPath(route);
  // Same short-circuit as writeWindowAppRoute (nav.ts:334-335): pathname only,
  // so an in-page hash such as #kb-main-board survives a no-op sync.
  if (router.history.location.pathname === href) return href;
  void router.navigate({
    href,
    replace: options?.replace ?? false,
    resetScroll: false,
  });
  return href;
}

/**
 * Whether the portfolio / connect navigations replace rather than push.
 *
 * BUG-COMPATIBILITY, deliberate. Three call sites used to invoke
 * `writeWindowBoardRoute(boardId, cardId, remoteSlug)` — passing the slug
 * positionally where nav.ts expects an options object (nav.ts:290-310, and
 * three TS2345 errors that `bun run typecheck` never saw because apps/web was
 * not in the typecheck script). nav.ts then evaluates `options?.replace`:
 *
 *   - slug is a string (including "") → that resolves to `String.prototype.replace`,
 *     a function, which is truthy → **replaceState**
 *   - slug is null/undefined        → undefined → **pushState**
 *
 * So the history behaviour of "open Projects", "open a board from a tile" and
 * "land after connect" silently depends on whether a remote slug is configured.
 * An A/B of the pre-router bundle against this one confirmed it: with the
 * fixture's `boards` slug the old build added no history entry, so Back skipped
 * straight past the portfolio.
 *
 * Reproducing it keeps back/forward byte-identical. It is almost certainly not
 * what anyone intended — fixing it means picking one of push/replace for all
 * three sites, which is a behaviour change and therefore a separate decision.
 */
export function legacySlugReplace(slug: string | null | undefined): boolean {
  return slug !== null && slug !== undefined;
}

/**
 * True for the history actions a `popstate` listener used to see.
 *
 * PUSH and REPLACE are the app writing its own URL. The old listener never
 * observed those (replaceState/pushState do not emit popstate), so neither does
 * this one — otherwise every URL sync would re-enter the route applier.
 */
export function isPopAction(action: HistorySubscriberArgs["action"]): boolean {
  return (
    action.type === "BACK" || action.type === "FORWARD" || action.type === "GO"
  );
}

/** Imperative route reader — no subscription, so it never causes a re-render. */
export function useAppRouteReader(): () => AppRoute {
  const router = useRouter();
  return useCallback(() => readAppRoute(router), [router]);
}

/** Imperative navigator with the same signature shape as writeWindowAppRoute. */
export function useNavigateTo(): (
  route: AppRoute,
  options?: { replace?: boolean },
) => string {
  const router = useRouter();
  return useCallback(
    (route: AppRoute, options?: { replace?: boolean }) =>
      navigateTo(router, route, options),
    [router],
  );
}

/**
 * Run `handler` on browser back / forward / go, and only then — the direct
 * replacement for the old `popstate` + `hashchange` listener pair.
 *
 * The handler is held in a ref so a caller that rebuilds it every render (the
 * old effect depended on `boardId`, `board`, `reload` and `remoteSlug`) does
 * not tear the subscription down and back up.
 */
export function usePopNavigation(handler: (route: AppRoute) => void): void {
  const router = useRouter();
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    return router.history.subscribe(
      ({ action, location }: HistorySubscriberArgs) => {
        if (!isPopAction(action)) return;
        ref.current(
          readWindowAppRoute(() => ({
            pathname: location.pathname,
            hash: location.hash,
          })),
        );
      },
    );
  }, [router]);
}
