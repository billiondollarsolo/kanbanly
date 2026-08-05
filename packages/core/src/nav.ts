/**
 * Board deep-link helpers.
 *
 * Spec paths (US-15):
 *   /r/<remote>/b/<boardId>
 *   /r/<remote>/b/<boardId>/<cardId>
 *
 * Also supported:
 *   /b/<boardId>[/<cardId>]
 *   #/r/... and #/b/... (hash fallback for static hosts)
 */

export type BoardRoute = {
  remoteSlug: string | null;
  boardId: string | null;
  cardId: string | null;
};

/**
 * Parse pathname and/or hash into remote/board/card route.
 * Prefers hash when present (SPA history may keep both during migration).
 */
export function parseBoardRoute(hashOrPath: string): BoardRoute {
  let raw = (hashOrPath || "").trim();
  // If full URL-ish with hash, prefer hash segment
  const hashIdx = raw.indexOf("#");
  if (hashIdx >= 0) {
    raw = raw.slice(hashIdx + 1);
  } else {
    raw = raw.replace(/^#/, "");
  }
  // strip origin if someone passed full URL pathname only
  try {
    if (raw.startsWith("http://") || raw.startsWith("https://")) {
      raw = new URL(raw).pathname;
    }
  } catch {
    /* ignore */
  }
  raw = raw.trim();
  if (!raw || raw === "/") {
    return { remoteSlug: null, boardId: null, cardId: null };
  }

  // /r/<remote>/b/<board>[/<card>]
  const withRemote = raw.match(
    /^\/r\/([^/]+)\/b\/([^/]+)(?:\/([^/]+))?\/?$/,
  );
  if (withRemote) {
    return {
      remoteSlug: decodeURIComponent(withRemote[1]!),
      boardId: decodeURIComponent(withRemote[2]!),
      cardId: withRemote[3] ? decodeURIComponent(withRemote[3]) : null,
    };
  }

  // /b/<board>[/<card>]
  const legacy = raw.match(/^\/b\/([^/]+)(?:\/([^/]+))?\/?$/);
  if (legacy) {
    return {
      remoteSlug: null,
      boardId: decodeURIComponent(legacy[1]!),
      cardId: legacy[2] ? decodeURIComponent(legacy[2]) : null,
    };
  }

  return { remoteSlug: null, boardId: null, cardId: null };
}

/**
 * Build route path (spec style, no hash).
 * Use with history.pushState / replaceState.
 */
export function formatBoardPath(
  boardId: string | null,
  cardId?: string | null,
  remoteSlug?: string | null,
): string {
  if (!boardId) return "/";
  const b = encodeURIComponent(boardId);
  const card = cardId ? `/${encodeURIComponent(cardId)}` : "";
  if (remoteSlug) {
    return `/r/${encodeURIComponent(remoteSlug)}/b/${b}${card}`;
  }
  return `/b/${b}${card}`;
}

/**
 * Build hash form (compat).
 */
export function formatBoardRoute(
  boardId: string | null,
  cardId?: string | null,
  remoteSlug?: string | null,
): string {
  const path = formatBoardPath(boardId, cardId, remoteSlug);
  return path === "/" ? "#/" : `#${path}`;
}

/**
 * Read current window route from pathname first, then hash.
 */
export function readWindowBoardRoute(
  getLocation: () => { pathname: string; hash: string } = () =>
    typeof window !== "undefined"
      ? { pathname: window.location.pathname, hash: window.location.hash }
      : { pathname: "/", hash: "" },
): BoardRoute {
  const { pathname, hash } = getLocation();
  if (hash && hash.length > 1) {
    const fromHash = parseBoardRoute(hash);
    if (fromHash.boardId) return fromHash;
  }
  return parseBoardRoute(pathname);
}

/**
 * Write board route into history (path-style by default).
 */
export function writeWindowBoardRoute(
  boardId: string | null,
  cardId: string | null | undefined,
  options?: {
    remoteSlug?: string | null;
    replace?: boolean;
    /** Prefer path (default) or hash for constrained hosts */
    mode?: "path" | "hash";
    setLocation?: (url: string, replace: boolean) => void;
  },
): string {
  const mode = options?.mode ?? "path";
  const url =
    mode === "hash"
      ? formatBoardRoute(boardId, cardId, options?.remoteSlug)
      : formatBoardPath(boardId, cardId, options?.remoteSlug);

  if (options?.setLocation) {
    options.setLocation(url, !!options.replace);
  } else if (typeof window !== "undefined") {
    if (mode === "hash") {
      if (options?.replace) {
        window.history.replaceState(null, "", url);
      } else if (window.location.hash !== url) {
        window.location.hash = url;
      }
    } else {
      const current = window.location.pathname;
      if (current === url) return url;
      if (options?.replace) {
        window.history.replaceState(null, "", url);
      } else {
        const curRoute = parseBoardRoute(window.location.pathname);
        const sameBoard =
          formatBoardPath(boardId, null, options?.remoteSlug) ===
          formatBoardPath(curRoute.boardId, null, curRoute.remoteSlug);
        if (sameBoard) {
          window.history.replaceState(null, "", url);
        } else {
          window.history.pushState(null, "", url);
        }
      }
    }
  }
  return url;
}

/** True if path is a board deep-link SPA route (server should serve index HTML). */
export function isSpaBoardPath(pathname: string): boolean {
  const p = pathname.split("?")[0] ?? "";
  return (
    p === "/" ||
    p === "/board" ||
    p === "/index.html" ||
    /^\/b\/[^/]+(?:\/[^/]+)?\/?$/.test(p) ||
    /^\/r\/[^/]+\/b\/[^/]+(?:\/[^/]+)?\/?$/.test(p)
  );
}
