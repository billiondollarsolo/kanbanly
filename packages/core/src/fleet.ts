/**
 * Unattended multi-agent fleet health: problems that need human attention
 * when you're not watching tens of long-running agents.
 */
import {
  buildPortfolio,
  type PortfolioBoardInput,
  type PortfolioTile,
} from "./portfolio.ts";
import { isAgentPickupColumn } from "./session.ts";

export type FleetIssueKind =
  | "p0_open"
  | "stale_doing"
  | "wip_over"
  | "no_pulse"
  | "blocked"
  | "no_ready";

export type FleetIssue = {
  kind: FleetIssueKind;
  severity: "high" | "medium" | "low";
  boardId: string;
  boardTitle: string;
  message: string;
  /** Optional related card */
  cardId?: string;
};

export type FleetHealth = {
  ok: boolean;
  generatedAt: string;
  boardCount: number;
  issueCount: number;
  highCount: number;
  issues: FleetIssue[];
  tiles: PortfolioTile[];
  /** Quick counters for digests / monitors */
  summary: {
    p0Total: number;
    staleTotal: number;
    wipOverBoards: number;
    silentBoards: number;
    blockedTotal: number;
  };
};

export type FleetHealthOptions = {
  staleHours?: number;
  /** Hours without any card update → no_pulse (default 12). */
  silentHours?: number;
  nowMs?: number;
};

/**
 * Build fleet health from the same board inputs as portfolio.
 * Pure — no I/O.
 */
export function buildFleetHealth(
  boards: PortfolioBoardInput[],
  options?: FleetHealthOptions,
): FleetHealth {
  const now = options?.nowMs ?? Date.now();
  const staleHours = options?.staleHours ?? 48;
  const silentHours = options?.silentHours ?? 12;
  const { tiles, p0Total, staleTotal } = buildPortfolio(boards, {
    staleHours,
    nowMs: now,
  });

  const issues: FleetIssue[] = [];

  for (const tile of tiles) {
    if (tile.p0Count > 0) {
      issues.push({
        kind: "p0_open",
        severity: "high",
        boardId: tile.boardId,
        boardTitle: tile.title,
        message: `${tile.p0Count} P0 card(s) open`,
      });
    }
    if (tile.staleDoingCount > 0) {
      issues.push({
        kind: "stale_doing",
        severity: "high",
        boardId: tile.boardId,
        boardTitle: tile.title,
        message: `${tile.staleDoingCount} Doing card(s) stale >${staleHours}h (agent may be stuck)`,
      });
    }
    if (tile.wipDoing.over) {
      issues.push({
        kind: "wip_over",
        severity: "medium",
        boardId: tile.boardId,
        boardTitle: tile.title,
        message: `Doing WIP ${tile.wipDoing.count}/${tile.wipDoing.limit} over soft limit`,
      });
    }
    if (tile.blockedCount > 0) {
      issues.push({
        kind: "blocked",
        severity: "medium",
        boardId: tile.boardId,
        boardTitle: tile.title,
        message: `${tile.blockedCount} blocked/waiting card(s)`,
      });
    }
    const last = tile.lastUpdated ? Date.parse(tile.lastUpdated) : NaN;
    const silent =
      !Number.isFinite(last) || now - last > silentHours * 3600_000;
    // Only flag silent if there is work in flight (doing) or ready queue
    const readyN = tile.columnCounts["ready"] ?? 0;
    if (silent && (tile.doingCount > 0 || readyN > 0)) {
      issues.push({
        kind: "no_pulse",
        severity: tile.doingCount > 0 ? "high" : "low",
        boardId: tile.boardId,
        boardTitle: tile.title,
        message:
          tile.doingCount > 0
            ? `No board update in >${silentHours}h while ${tile.doingCount} in Doing`
            : `No board update in >${silentHours}h with Ready queue (${readyN})`,
      });
    }
    if (readyN === 0 && tile.doingCount === 0) {
      const hasInbox = (tile.columnCounts["inbox"] ?? 0) > 0;
      if (hasInbox) {
        issues.push({
          kind: "no_ready",
          severity: "low",
          boardId: tile.boardId,
          boardTitle: tile.title,
          message: "Inbox has work but Ready is empty — agents have nothing to pick up",
        });
      }
    }
  }

  const severityRank = { high: 0, medium: 1, low: 2 };
  issues.sort(
    (a, b) =>
      severityRank[a.severity] - severityRank[b.severity] ||
      a.boardTitle.localeCompare(b.boardTitle),
  );

  const highCount = issues.filter((i) => i.severity === "high").length;
  const wipOverBoards = tiles.filter((t) => t.wipDoing.over).length;
  const silentBoards = issues.filter((i) => i.kind === "no_pulse").length;
  const blockedTotal = tiles.reduce((n, t) => n + t.blockedCount, 0);

  return {
    ok: highCount === 0,
    generatedAt: new Date(now).toISOString(),
    boardCount: boards.length,
    issueCount: issues.length,
    highCount,
    issues,
    tiles,
    summary: {
      p0Total,
      staleTotal,
      wipOverBoards,
      silentBoards,
      blockedTotal,
    },
  };
}

/** Whether board settings request hard WIP enforcement. */
export function isHardWip(settings: Record<string, unknown> | undefined | null): boolean {
  const v = settings?.wipHard;
  return v === true || v === "true" || v === 1 || v === "1";
}

export type FleetDigestOptions = {
  /** Max issues to list (default 20). */
  maxIssues?: number;
  /** Include per-board velocity one-liners (default true). */
  includeTiles?: boolean;
};

/**
 * Human-readable fleet digest for cron, Slack, email, or CLI.
 * Stable plain text — no ANSI.
 */
export function formatFleetDigest(
  health: FleetHealth,
  options?: FleetDigestOptions,
): string {
  const maxIssues = options?.maxIssues ?? 20;
  const includeTiles = options?.includeTiles !== false;
  const lines: string[] = [];
  const status = health.ok ? "OK" : "NEEDS ATTENTION";
  lines.push(`kanbanly fleet · ${status}`);
  lines.push(`generated ${health.generatedAt}`);
  lines.push(
    `boards ${health.boardCount} · issues ${health.issueCount} (${health.highCount} high)`,
  );
  lines.push(
    `P0 ${health.summary.p0Total} · stale Doing ${health.summary.staleTotal} · silent ${health.summary.silentBoards} · WIP over ${health.summary.wipOverBoards} · blocked ${health.summary.blockedTotal}`,
  );

  if (health.issues.length > 0) {
    lines.push("");
    lines.push("Issues:");
    for (const issue of health.issues.slice(0, maxIssues)) {
      const sev = issue.severity.toUpperCase().padEnd(6);
      lines.push(`  [${sev}] ${issue.boardTitle}: ${issue.message}`);
    }
    if (health.issues.length > maxIssues) {
      lines.push(`  … +${health.issues.length - maxIssues} more`);
    }
  }

  if (includeTiles && health.tiles.length > 0) {
    lines.push("");
    lines.push("Boards:");
    for (const t of health.tiles) {
      const vel = t.velocity;
      const done = vel?.done7d ?? 0;
      const pulse =
        vel?.pulseAgeHours == null
          ? "no pulse"
          : vel.pulseAgeHours < 48
            ? `${vel.pulseAgeHours}h`
            : `${Math.round(vel.pulseAgeHours / 24)}d`;
      const commits =
        vel?.codeCommits7d == null ? "—" : String(vel.codeCommits7d);
      lines.push(
        `  ${t.title} [${t.health}] · ${t.doingCount} doing · ${done} done/7d · ${commits} commits/7d · pulse ${pulse}`,
      );
    }
  }

  return lines.join("\n");
}

/**
 * JSON body suitable for Slack incoming webhooks and generic monitors.
 * Slack reads `text`; other systems can use `digest` / counters.
 */
export function fleetWebhookPayload(health: FleetHealth): {
  text: string;
  content: string;
  digest: string;
  ok: boolean;
  highCount: number;
  issueCount: number;
  boardCount: number;
  summary: FleetHealth["summary"];
  generatedAt: string;
} {
  const digest = formatFleetDigest(health, { maxIssues: 12, includeTiles: false });
  return {
    text: digest,
    content: digest,
    digest,
    ok: health.ok,
    highCount: health.highCount,
    issueCount: health.issueCount,
    boardCount: health.boardCount,
    summary: health.summary,
    generatedAt: health.generatedAt,
  };
}

export { isAgentPickupColumn };
