/**
 * Multi-board portfolio / at-a-glance helpers (pure).
 * Home of kanbanly for multi-project AI fleets: health + velocity signals.
 */
import { buildActivityFeed, parseLogLine, type ActivityEntry } from "./activity.ts";
import { resolveCodeBinding } from "./project-cockpit.ts";
import { checkDoingWip } from "./session.ts";

export type PortfolioCard = {
  id: string;
  title: string;
  column: string;
  priority?: string;
  assignee?: string;
  updated: string;
  log: string[];
};

export type PortfolioBoardInput = {
  id: string;
  title: string;
  columns: Array<{ id: string; name: string }>;
  cards: PortfolioCard[];
  /** board.yml settings bag */
  settings?: Record<string, unknown>;
  /**
   * Optional code velocity filled by server after git log on bound source.
   * null = unbound / unknown; number = commits in window.
   */
  codeCommits7d?: number | null;
  codeCommits24h?: number | null;
};

export type PortfolioVelocity = {
  windowDays: number;
  /** Cards currently in done/review with updated in window (proxy for throughput). */
  done7d: number;
  review7d: number;
  /** Log lines with a parseable date in the window (agent/human board activity). */
  logEvents7d: number;
  /** Log lines attributed to non-human actors in the window. */
  agentEvents7d: number;
  /** Hours since last card.updated (null if never). */
  pulseAgeHours: number | null;
  /** Source-repo commits in 7d / 24h (null if not bound or not measured). */
  codeCommits7d: number | null;
  codeCommits24h: number | null;
};

export type PortfolioHealth =
  | "healthy"
  | "busy"
  | "stale"
  | "silent"
  | "blocked"
  | "idle";

export type PortfolioTile = {
  boardId: string;
  title: string;
  cardCount: number;
  columnCounts: Record<string, number>;
  p0Count: number;
  doingCount: number;
  blockedCount: number;
  readyCount: number;
  /** ISO-ish last card updated max */
  lastUpdated: string | null;
  lastActivity: {
    date: string;
    line: string;
    actor?: string;
    cardId: string;
    cardTitle: string;
  } | null;
  lastAgent: string | null;
  staleDoingCount: number;
  codeBound: boolean;
  /** Soft WIP: doing count vs settings.wipDoing */
  wipDoing: { count: number; limit: number; over: boolean };
  velocity: PortfolioVelocity;
  health: PortfolioHealth;
};

export type CrossBoardActivityEntry = ActivityEntry & {
  boardId: string;
  boardTitle: string;
};

export function isDoingColumn(id: string): boolean {
  return /^(doing|today|in-progress|in_progress|wip)$/i.test(id);
}

export function isBlockedColumn(id: string): boolean {
  return /^(blocked|waiting|on-hold|on_hold|hold)$/i.test(id);
}

export function isDoneColumn(id: string): boolean {
  return /^(done|complete|completed|shipped)$/i.test(id);
}

export function isReviewColumn(id: string): boolean {
  return /^(review|pr|in-review|in_review)$/i.test(id);
}

function inWindow(isoOrDate: string, sinceMs: number): boolean {
  // Accept full ISO or YYYY-MM-DD
  const t = Date.parse(
    isoOrDate.length === 10 ? `${isoOrDate}T12:00:00Z` : isoOrDate,
  );
  return Number.isFinite(t) && t >= sinceMs;
}

/**
 * Build one portfolio tile from board index data.
 * @param nowMs — injectable clock for stale/velocity windows (tests).
 */
export function buildPortfolioTile(
  board: PortfolioBoardInput,
  options?: { staleHours?: number; nowMs?: number; velocityDays?: number },
): PortfolioTile {
  const staleHours = options?.staleHours ?? 48;
  const velocityDays = options?.velocityDays ?? 7;
  const now = options?.nowMs ?? Date.now();
  const since7d = now - velocityDays * 24 * 3600_000;
  const columnCounts: Record<string, number> = {};
  for (const col of board.columns) {
    columnCounts[col.id] = 0;
  }
  let p0Count = 0;
  let doingCount = 0;
  let blockedCount = 0;
  let readyCount = 0;
  let lastUpdated: string | null = null;
  let staleDoingCount = 0;
  let done7d = 0;
  let review7d = 0;
  let logEvents7d = 0;
  let agentEvents7d = 0;

  for (const c of board.cards) {
    columnCounts[c.column] = (columnCounts[c.column] ?? 0) + 1;
    if ((c.priority ?? "").toUpperCase() === "P0") p0Count += 1;
    if (c.column === "ready") readyCount += 1;
    if (isDoingColumn(c.column)) {
      doingCount += 1;
      const t = Date.parse(c.updated);
      if (Number.isFinite(t) && now - t > staleHours * 3600_000) {
        staleDoingCount += 1;
      }
    }
    if (isBlockedColumn(c.column)) blockedCount += 1;
    if (isDoneColumn(c.column) && inWindow(c.updated, since7d)) done7d += 1;
    if (isReviewColumn(c.column) && inWindow(c.updated, since7d)) review7d += 1;
    if (!lastUpdated || c.updated > lastUpdated) lastUpdated = c.updated;

    for (const raw of c.log ?? []) {
      const p = parseLogLine(raw);
      if (p.date !== "0000-00-00" && inWindow(p.date, since7d)) {
        logEvents7d += 1;
        if (p.actor && p.actor !== "human") agentEvents7d += 1;
      }
    }
  }

  const feed = buildActivityFeed(
    board.cards.map((c) => ({ id: c.id, title: c.title, log: c.log })),
    { limit: 1 },
  );
  const top = feed[0] ?? null;
  let lastAgent: string | null = null;
  for (const c of board.cards) {
    for (let i = c.log.length - 1; i >= 0; i--) {
      const p = parseLogLine(c.log[i]!);
      if (p.actor && p.actor !== "human") {
        lastAgent = p.actor;
        break;
      }
    }
    if (lastAgent) break;
  }
  if (top?.actor && top.actor !== "human") lastAgent = top.actor;

  const binding = resolveCodeBinding(board.settings);
  const codeBound = !!(binding?.path || binding?.remote);
  const wip = checkDoingWip(doingCount, board.settings);

  let pulseAgeHours: number | null = null;
  if (lastUpdated) {
    const t = Date.parse(lastUpdated);
    if (Number.isFinite(t)) {
      pulseAgeHours = Math.max(0, Math.round((now - t) / 3600_000));
    }
  }

  // Only expose code velocity when a project source is bound (null = unbound / unknown).
  const velocity: PortfolioVelocity = {
    windowDays: velocityDays,
    done7d,
    review7d,
    logEvents7d,
    agentEvents7d,
    pulseAgeHours,
    codeCommits7d: codeBound ? (board.codeCommits7d ?? null) : null,
    codeCommits24h: codeBound ? (board.codeCommits24h ?? null) : null,
  };

  const health = derivePortfolioHealth({
    p0Count,
    doingCount,
    blockedCount,
    readyCount,
    staleDoingCount,
    pulseAgeHours,
    done7d,
    codeCommits7d: velocity.codeCommits7d,
    codeBound,
    logEvents7d,
  });

  return {
    boardId: board.id,
    title: board.title,
    cardCount: board.cards.length,
    columnCounts,
    p0Count,
    doingCount,
    blockedCount,
    readyCount,
    lastUpdated,
    lastActivity: top
      ? {
          date: top.date,
          line: top.line,
          actor: top.actor,
          cardId: top.cardId,
          cardTitle: top.cardTitle,
        }
      : null,
    lastAgent,
    staleDoingCount,
    codeBound,
    wipDoing: { count: wip.count, limit: wip.limit, over: wip.over },
    velocity,
    health,
  };
}

export function derivePortfolioHealth(input: {
  p0Count: number;
  doingCount: number;
  blockedCount: number;
  readyCount: number;
  staleDoingCount: number;
  pulseAgeHours: number | null;
  done7d: number;
  codeCommits7d: number | null;
  codeBound: boolean;
  logEvents7d: number;
}): PortfolioHealth {
  if (input.staleDoingCount > 0) return "stale";
  if (
    input.doingCount > 0 &&
    input.pulseAgeHours != null &&
    input.pulseAgeHours >= 12
  ) {
    return "silent";
  }
  if (input.blockedCount > 0 && input.doingCount === 0) return "blocked";
  if (input.doingCount > 0 || input.logEvents7d > 5 || (input.codeCommits7d ?? 0) > 5) {
    return "busy";
  }
  if (input.done7d > 0 || input.readyCount > 0 || input.p0Count > 0) return "healthy";
  return "idle";
}

export function buildPortfolio(
  boards: PortfolioBoardInput[],
  options?: {
    staleHours?: number;
    nowMs?: number;
    activityLimit?: number;
    velocityDays?: number;
  },
): {
  tiles: PortfolioTile[];
  activity: CrossBoardActivityEntry[];
  p0Total: number;
  staleTotal: number;
  /** Portfolio-wide velocity rollup */
  velocity: {
    windowDays: number;
    done7d: number;
    logEvents7d: number;
    agentEvents7d: number;
    codeCommits7d: number;
    codeCommits24h: number;
  };
} {
  const velocityDays = options?.velocityDays ?? 7;
  const tiles = boards.map((b) => buildPortfolioTile(b, options));
  // Sort: attention first (stale/silent/P0), then busy, then title
  const healthRank: Record<PortfolioHealth, number> = {
    stale: 0,
    silent: 1,
    blocked: 2,
    busy: 3,
    healthy: 4,
    idle: 5,
  };
  tiles.sort((a, b) => {
    if (a.p0Count !== b.p0Count) return b.p0Count - a.p0Count;
    const hr = healthRank[a.health] - healthRank[b.health];
    if (hr !== 0) return hr;
    if (a.staleDoingCount !== b.staleDoingCount) {
      return b.staleDoingCount - a.staleDoingCount;
    }
    const au = a.lastUpdated ?? "";
    const bu = b.lastUpdated ?? "";
    return bu < au ? -1 : bu > au ? 1 : a.title.localeCompare(b.title);
  });

  const activity: CrossBoardActivityEntry[] = [];
  for (const board of boards) {
    const feed = buildActivityFeed(
      board.cards.map((c) => ({ id: c.id, title: c.title, log: c.log })),
      { limit: 50 },
    );
    for (const e of feed) {
      activity.push({
        ...e,
        boardId: board.id,
        boardTitle: board.title,
      });
    }
  }
  activity.sort((a, b) => {
    if (a.date > b.date) return -1;
    if (a.date < b.date) return 1;
    return a.line < b.line ? -1 : a.line > b.line ? 1 : 0;
  });
  const limit = options?.activityLimit ?? 40;
  return {
    tiles,
    activity: activity.slice(0, limit),
    p0Total: tiles.reduce((n, t) => n + t.p0Count, 0),
    staleTotal: tiles.reduce((n, t) => n + t.staleDoingCount, 0),
    velocity: {
      windowDays: velocityDays,
      done7d: tiles.reduce((n, t) => n + t.velocity.done7d, 0),
      logEvents7d: tiles.reduce((n, t) => n + t.velocity.logEvents7d, 0),
      agentEvents7d: tiles.reduce((n, t) => n + t.velocity.agentEvents7d, 0),
      codeCommits7d: tiles.reduce(
        (n, t) => n + (t.velocity.codeCommits7d ?? 0),
        0,
      ),
      codeCommits24h: tiles.reduce(
        (n, t) => n + (t.velocity.codeCommits24h ?? 0),
        0,
      ),
    },
  };
}

/** Count commits with author date in the last `days` (from ProjectCommit.date). */
export function countCommitsInWindow(
  commits: Array<{ date: string }>,
  days: number,
  nowMs = Date.now(),
): number {
  const since = nowMs - days * 24 * 3600_000;
  let n = 0;
  for (const c of commits) {
    if (inWindow(c.date, since)) n += 1;
  }
  return n;
}

/** GitHub commit URL from remote clone URL, or null. */
export function githubCommitUrl(
  remote: string | null | undefined,
  sha: string,
): string | null {
  if (!remote || !sha) return null;
  const m = remote.match(
    /github\.com[/:]([^/]+)\/([^/.]+?)(?:\.git)?$/i,
  );
  if (!m) return null;
  return `https://github.com/${m[1]}/${m[2]}/commit/${sha}`;
}

/** Human pulse label e.g. "2h ago", "3d ago". */
export function formatPulseAge(hours: number | null): string {
  if (hours == null) return "no pulse";
  if (hours < 1) return "<1h ago";
  if (hours < 48) return `${hours}h ago`;
  const d = Math.round(hours / 24);
  return `${d}d ago`;
}
