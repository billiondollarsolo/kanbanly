/**
 * App deep-link helpers.
 *
 * Board / card (US-15):
 *   /b/<boardId>
 *   /b/<boardId>/<cardId>
 *   /r/<remote>/b/<boardId>
 *   /r/<remote>/b/<boardId>/<cardId>
 *
 * Settings:
 *   /settings
 *   /settings/<section>
 *   /settings/boards/<boardId>
 *   /settings/r/<remote>/boards/<boardId>
 *
 * Hash forms (#/…) still accepted for static hosts.
 */

export type SettingsSection =
  | "boards"
  | "repositories"
  | "credentials"
  | "filters"
  | "theme"
  | "activity";

export const SETTINGS_SECTIONS: SettingsSection[] = [
  "boards",
  "repositories",
  "credentials",
  "filters",
  "theme",
  "activity",
];

export function isSettingsSection(v: string): v is SettingsSection {
  return (SETTINGS_SECTIONS as string[]).includes(v);
}

/** Board deep-link (legacy BoardRoute shape). */
export type BoardRoute = {
  remoteSlug: string | null;
  boardId: string | null;
  cardId: string | null;
};

/** Full app route including settings. */
export type AppRoute =
  | {
      kind: "board";
      remoteSlug: string | null;
      boardId: string | null;
      cardId: string | null;
    }
  | {
      kind: "settings";
      section: SettingsSection;
      /** Expanded board in settings (boards section). */
      remoteSlug: string | null;
      boardId: string | null;
    }
  | { kind: "home" };

function stripToPath(hashOrPath: string): string {
  let raw = (hashOrPath || "").trim();
  const hashIdx = raw.indexOf("#");
  if (hashIdx >= 0) {
    raw = raw.slice(hashIdx + 1);
  } else {
    raw = raw.replace(/^#/, "");
  }
  try {
    if (raw.startsWith("http://") || raw.startsWith("https://")) {
      raw = new URL(raw).pathname;
    }
  } catch {
    /* ignore */
  }
  raw = raw.trim();
  if (!raw.startsWith("/")) raw = `/${raw}`;
  // drop query
  raw = raw.split("?")[0] ?? raw;
  return raw.replace(/\/+$/, "") || "/";
}

/**
 * Parse pathname and/or hash into remote/board/card route.
 * Prefers hash when present (SPA history may keep both during migration).
 */
export function parseBoardRoute(hashOrPath: string): BoardRoute {
  const app = parseAppRoute(hashOrPath);
  if (app.kind === "board") {
    return {
      remoteSlug: app.remoteSlug,
      boardId: app.boardId,
      cardId: app.cardId,
    };
  }
  if (app.kind === "settings" && app.boardId) {
    return {
      remoteSlug: app.remoteSlug,
      boardId: app.boardId,
      cardId: null,
    };
  }
  return { remoteSlug: null, boardId: null, cardId: null };
}

/** Parse full app route (boards + settings). */
export function parseAppRoute(hashOrPath: string): AppRoute {
  const raw = stripToPath(hashOrPath);
  if (!raw || raw === "/") {
    return { kind: "home" };
  }

  // /settings[/section][/…]
  const settings = raw.match(/^\/settings(?:\/([^/]+))?(?:\/(.*))?$/);
  if (settings) {
    const secRaw = settings[1];
    const rest = settings[2] ?? "";

    // /settings/r/<remote>/boards/<boardId>
    const nested = rest
      ? null
      : null;
    void nested;
    if (secRaw === "r" || (secRaw && rest)) {
      // /settings/r/<remote>/boards/<id>
      const full = raw.match(
        /^\/settings\/r\/([^/]+)\/boards\/([^/]+)\/?$/,
      );
      if (full) {
        return {
          kind: "settings",
          section: "boards",
          remoteSlug: decodeURIComponent(full[1]!),
          boardId: decodeURIComponent(full[2]!),
        };
      }
    }

    // /settings/boards/<boardId>
    if (secRaw === "boards" && rest) {
      const boardOnly = rest.match(/^([^/]+)\/?$/);
      if (boardOnly) {
        return {
          kind: "settings",
          section: "boards",
          remoteSlug: null,
          boardId: decodeURIComponent(boardOnly[1]!),
        };
      }
    }

    const section: SettingsSection =
      secRaw && isSettingsSection(secRaw) ? secRaw : "boards";
    return {
      kind: "settings",
      section,
      remoteSlug: null,
      boardId: null,
    };
  }

  // /r/<remote>/b/<board>[/<card>]
  const withRemote = raw.match(
    /^\/r\/([^/]+)\/b\/([^/]+)(?:\/([^/]+))?\/?$/,
  );
  if (withRemote) {
    return {
      kind: "board",
      remoteSlug: decodeURIComponent(withRemote[1]!),
      boardId: decodeURIComponent(withRemote[2]!),
      cardId: withRemote[3] ? decodeURIComponent(withRemote[3]) : null,
    };
  }

  // /b/<board>[/<card>]
  const legacy = raw.match(/^\/b\/([^/]+)(?:\/([^/]+))?\/?$/);
  if (legacy) {
    return {
      kind: "board",
      remoteSlug: null,
      boardId: decodeURIComponent(legacy[1]!),
      cardId: legacy[2] ? decodeURIComponent(legacy[2]) : null,
    };
  }

  return { kind: "home" };
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
 * Build settings path.
 */
export function formatSettingsPath(
  section: SettingsSection = "boards",
  options?: { remoteSlug?: string | null; boardId?: string | null },
): string {
  if (options?.boardId) {
    if (options.remoteSlug) {
      return `/settings/r/${encodeURIComponent(options.remoteSlug)}/boards/${encodeURIComponent(options.boardId)}`;
    }
    return `/settings/boards/${encodeURIComponent(options.boardId)}`;
  }
  if (section === "boards") return "/settings/boards";
  return `/settings/${section}`;
}

/**
 * Format any app route to a path string.
 */
export function formatAppPath(route: AppRoute): string {
  if (route.kind === "home") return "/";
  if (route.kind === "settings") {
    return formatSettingsPath(route.section, {
      remoteSlug: route.remoteSlug,
      boardId: route.boardId,
    });
  }
  return formatBoardPath(route.boardId, route.cardId, route.remoteSlug);
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
  const app = readWindowAppRoute(getLocation);
  if (app.kind === "board") {
    return {
      remoteSlug: app.remoteSlug,
      boardId: app.boardId,
      cardId: app.cardId,
    };
  }
  return { remoteSlug: null, boardId: null, cardId: null };
}

export function readWindowAppRoute(
  getLocation: () => { pathname: string; hash: string } = () =>
    typeof window !== "undefined"
      ? { pathname: window.location.pathname, hash: window.location.hash }
      : { pathname: "/", hash: "" },
): AppRoute {
  const { pathname, hash } = getLocation();
  if (hash && hash.length > 1) {
    const fromHash = parseAppRoute(hash);
    if (fromHash.kind !== "home") return fromHash;
  }
  return parseAppRoute(pathname);
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
  return writeWindowAppRoute(
    {
      kind: "board",
      boardId,
      cardId: cardId ?? null,
      remoteSlug: options?.remoteSlug ?? null,
    },
    options,
  );
}

export function writeWindowAppRoute(
  route: AppRoute,
  options?: {
    replace?: boolean;
    mode?: "path" | "hash";
    setLocation?: (url: string, replace: boolean) => void;
  },
): string {
  const mode = options?.mode ?? "path";
  const path = formatAppPath(route);
  const url = mode === "hash" ? (path === "/" ? "#/" : `#${path}`) : path;

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
        window.history.pushState(null, "", url);
      }
    }
  }
  return url;
}

/** True if path is an SPA route (server should serve index HTML). */
export function isSpaBoardPath(pathname: string): boolean {
  const p = (pathname.split("?")[0] ?? "").replace(/\/+$/, "") || "/";
  if (
    p === "/" ||
    p === "/board" ||
    p === "/index.html" ||
    p === "/settings"
  ) {
    return true;
  }
  if (p.startsWith("/settings/")) return true;
  return (
    /^\/b\/[^/]+(?:\/[^/]+)?$/.test(p) ||
    /^\/r\/[^/]+\/b\/[^/]+(?:\/[^/]+)?$/.test(p)
  );
}
