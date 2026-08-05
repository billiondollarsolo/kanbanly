/**
 * Agent session helpers: validate pickup columns, format session-end log lines,
 * session-start brief, WIP checks, commit→card id extraction.
 */
import type { Card } from "./card.ts";
import { serializeCard } from "./card.ts";
import { DEFAULT_WIP_DOING } from "./board.ts";
import type { ProjectCommit } from "./project-cockpit.ts";

export const AGENT_PICKUP_COLUMNS = ["ready", "doing"] as const;

/** Card ids embedded in commit subjects: c- + hex (long or short legacy). */
const CARD_ID_IN_TEXT = /\bc-[0-9a-f]{4,32}\b/gi;

export type SessionEndInput = {
  card: Card;
  summary: string;
  actor?: string;
  /** Optional new Status overwrite */
  status?: string;
  /** Optional short code SHA to include in the log line */
  sha?: string;
  /** ISO date YYYY-MM-DD; default today UTC */
  date?: string;
};

export type SessionEndResult = {
  card: Card;
  logLine: string;
  markdown: string;
};

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** True if an agent may start work from this column (Ready or already Doing). */
export function isAgentPickupColumn(columnId: string): boolean {
  const id = columnId.trim().toLowerCase();
  return (AGENT_PICKUP_COLUMNS as readonly string[]).includes(id);
}

/**
 * Validate agent may pick up this card.
 * - Ready: always ok to start
 * - Doing: ok if unassigned or assignee matches actor
 * - Else: not allowed
 */
export function canAgentPickup(
  card: Pick<Card, "frontmatter">,
  actor = "agent",
): { ok: true } | { ok: false; reason: string } {
  const col = card.frontmatter.column.trim().toLowerCase();
  if (col === "ready") return { ok: true };
  if (col === "doing") {
    const a = card.frontmatter.assignee?.trim();
    if (!a || a === actor) return { ok: true };
    return {
      ok: false,
      reason: `Card is Doing and assigned to ${a} (not ${actor})`,
    };
  }
  return {
    ok: false,
    reason: `Agents only pick Ready or assigned Doing (column is “${card.frontmatter.column}”)`,
  };
}

/** Append a session-end log line (and optional status) to a card. Pure. */
export function applySessionEnd(input: SessionEndInput): SessionEndResult {
  const actor = (input.actor ?? "agent").trim() || "agent";
  const date = input.date ?? todayUtc();
  const summary = input.summary.trim();
  if (!summary) {
    throw new Error("session-end summary is required");
  }
  let text = summary;
  if (input.sha?.trim()) {
    text = `${summary} · ${input.sha.trim().slice(0, 12)}`;
  }
  const logLine = `${date} ${actor}: session-end — ${text}`;
  const log = [...(input.card.log ?? []), logLine];
  const status =
    input.status !== undefined ? input.status : input.card.status;
  const card: Card = {
    frontmatter: {
      ...input.card.frontmatter,
      assignee: input.card.frontmatter.assignee ?? actor,
      updated: nowIso(),
    },
    status,
    log,
  };
  return {
    card,
    logLine,
    markdown: serializeCard(card),
  };
}

/** Extract unique card ids mentioned in free text (e.g. commit subjects). */
export function extractCardIdsFromText(text: string): string[] {
  const found = text.match(CARD_ID_IN_TEXT) ?? [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of found) {
    const id = raw.toLowerCase();
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export function wipDoingLimit(
  settings: Record<string, unknown> | undefined | null,
): number {
  const n = settings?.wipDoing;
  if (typeof n === "number" && Number.isFinite(n) && n > 0) return Math.floor(n);
  if (typeof n === "string" && /^\d+$/.test(n)) return Math.max(1, Number(n));
  return DEFAULT_WIP_DOING;
}

/** Soft WIP check: moving into Doing when already at/over limit. */
export function checkDoingWip(
  doingCount: number,
  settings?: Record<string, unknown> | null,
  options?: { movingIntoDoing?: boolean },
): { over: boolean; limit: number; count: number; message?: string } {
  const limit = wipDoingLimit(settings);
  const count = doingCount;
  const projected =
    options?.movingIntoDoing && count >= 0 ? count + 1 : count;
  const over = projected > limit;
  return {
    over,
    limit,
    count,
    message: over
      ? `Doing WIP ${projected > count ? `${count}→${projected}` : String(count)} exceeds limit ${limit}`
      : undefined,
  };
}

export type SessionStartCard = {
  id: string;
  title: string;
  column: string;
  priority?: string;
  assignee?: string;
};

export type SessionStartBrief = {
  boardId: string;
  boardTitle: string;
  notesPreview: string;
  readyCards: SessionStartCard[];
  doingCards: SessionStartCard[];
  commits: Array<{ sha: string; subject: string; author: string; date: string }>;
  pickupHint: string;
  wip: { count: number; limit: number; over: boolean };
};

/** Build a text/JSON-friendly session-start brief for agents. */
export function buildSessionStartBrief(input: {
  boardId: string;
  boardTitle: string;
  notesBody?: string;
  cards: SessionStartCard[];
  commits?: ProjectCommit[];
  settings?: Record<string, unknown> | null;
  actor?: string;
}): SessionStartBrief {
  const actor = input.actor ?? "agent";
  const readyCards = input.cards.filter((c) => c.column === "ready");
  const doingCards = input.cards.filter((c) => c.column === "doing");
  const wip = checkDoingWip(doingCards.length, input.settings);
  const notes = (input.notesBody ?? "").trim();
  const notesPreview =
    notes.length === 0
      ? "(no NOTES.md yet)"
      : notes.length > 800
        ? notes.slice(0, 800) + "…"
        : notes;
  const pickupHint =
    readyCards.length > 0
      ? `Pick a Ready card (${readyCards.length} available); set assignee=${actor}; move to Doing.`
      : doingCards.some((c) => !c.assignee || c.assignee === actor)
        ? `Continue your Doing card(s); no Ready cards waiting.`
        : `No Ready cards — ask human to groom Inbox → Ready.`;

  return {
    boardId: input.boardId,
    boardTitle: input.boardTitle,
    notesPreview,
    readyCards,
    doingCards,
    commits: (input.commits ?? []).slice(0, 10).map((c) => ({
      sha: c.sha.slice(0, 7),
      subject: c.subject,
      author: c.author,
      date: c.date.slice(0, 10),
    })),
    pickupHint,
    wip: { count: wip.count, limit: wip.limit, over: wip.over },
  };
}

export function formatSessionStartBrief(brief: SessionStartBrief): string {
  const lines: string[] = [
    `# Session start · ${brief.boardTitle} (${brief.boardId})`,
    "",
    "## Pickup",
    brief.pickupHint,
    `WIP Doing: ${brief.wip.count}/${brief.wip.limit}${brief.wip.over ? " ⚠ over limit" : ""}`,
    "",
    "## Notes (preview)",
    brief.notesPreview,
    "",
    "## Ready",
  ];
  if (brief.readyCards.length === 0) lines.push("(none)");
  for (const c of brief.readyCards) {
    lines.push(
      `- ${c.id} ${c.priority ? `[${c.priority}] ` : ""}${c.title}`,
    );
  }
  lines.push("", "## Doing");
  if (brief.doingCards.length === 0) lines.push("(none)");
  for (const c of brief.doingCards) {
    lines.push(
      `- ${c.id} ${c.assignee ? `@${c.assignee} ` : ""}${c.title}`,
    );
  }
  lines.push("", "## Recent project commits");
  if (brief.commits.length === 0) lines.push("(none / unbound)");
  for (const c of brief.commits) {
    lines.push(`- ${c.sha} ${c.subject} (${c.author}, ${c.date})`);
  }
  return lines.join("\n") + "\n";
}
