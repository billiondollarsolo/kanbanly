/**
 * Skill / AGENTS.md conformance helpers (US-9).
 * Simulates the agent procedure documented in boardsAgentsMd() without an LLM:
 * generate id, append order after last, write schema-valid card markdown.
 */

import { boardsAgentsMd } from "./setup.ts";
import { generateCardId, cardFilename } from "./id.ts";
import { orderAfter, orderInitial } from "./order.ts";
import { parseCard, serializeCard, type Card } from "./card.ts";

export type AgentCreateInput = {
  title: string;
  column: string;
  /** Existing card ids in the board. */
  existingIds: string[];
  /** Orders of cards already in the target column (agent never inserts between). */
  columnOrders: string[];
  actor?: string;
  labels?: string[];
  status?: string;
};

/**
 * Required section headings / rules that must appear in boards AGENTS.md.
 */
export const AGENTS_MD_REQUIRED_MARKERS = [
  "Card schema",
  "ID generation",
  "Order rule",
  "Never insert between",
  "## Status",
  "## Log",
  "Re-read",
  "column",
  "order",
  "updated",
  "source of truth",
  "NOTES.md",
  "Session protocol",
  "short SHA",
  "Ready",
  "session-end",
] as const;

/** Assert AGENTS.md content documents the contract (static conformance). */
export function agentsMdConforms(md: string = boardsAgentsMd()): {
  ok: boolean;
  missing: string[];
} {
  const missing = AGENTS_MD_REQUIRED_MARKERS.filter(
    (m) => !md.toLowerCase().includes(m.toLowerCase()),
  );
  return { ok: missing.length === 0, missing: [...missing] };
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Follow the agent procedure from AGENTS.md:
 * mint id, order after max in column, Status _Not started._, Log create line.
 */
export function agentCreateCard(input: AgentCreateInput): {
  card: Card;
  filename: string;
  markdown: string;
} {
  const id = generateCardId(input.existingIds);
  // Order-only compare (ids unused when orders differ)
  let last: string | null = null;
  for (const o of input.columnOrders) {
    if (last === null || o > last) last = o;
  }
  const order = last === null ? orderInitial() : orderAfter(last);
  const actor = input.actor ?? "agent";
  const card: Card = {
    frontmatter: {
      id,
      title: input.title,
      column: input.column,
      order,
      updated: nowIso(),
      labels: input.labels ?? [],
    },
    status: input.status ?? "_Not started._",
    log: [`${today()} ${actor}: created`],
  };
  const markdown = serializeCard(card);
  return {
    card,
    filename: cardFilename(id, input.title),
    markdown,
  };
}

/**
 * Validate that agent-produced markdown is schema-valid and obeys append-only order.
 */
export function validateAgentCard(
  markdown: string,
  options?: {
    columnOrdersBefore?: string[];
  },
): { ok: true; card: Card } | { ok: false; errors: string[] } {
  const parsed = parseCard(markdown);
  if (!parsed.ok) {
    return { ok: false, errors: [parsed.error.message] };
  }
  const card = parsed.card;
  const errors: string[] = [];
  if (!/^c-[a-z0-9]+$/i.test(card.frontmatter.id)) {
    errors.push(`invalid id: ${card.frontmatter.id}`);
  }
  if (!card.frontmatter.title.trim()) errors.push("empty title");
  if (!card.frontmatter.column.trim()) errors.push("empty column");
  if (!card.frontmatter.order) errors.push("missing order");
  if (!card.frontmatter.updated) errors.push("missing updated");

  const prior = options?.columnOrdersBefore ?? [];
  if (prior.length > 0) {
    const maxPrior = prior.reduce((a, b) => (a >= b ? a : b));
    if (card.frontmatter.order <= maxPrior) {
      errors.push(
        `order ${card.frontmatter.order} does not sort after max prior ${maxPrior} (agents must append)`,
      );
    }
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, card };
}
