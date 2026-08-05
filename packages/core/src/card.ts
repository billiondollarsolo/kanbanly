import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";

/** Zod schema for card frontmatter. Required: id, title, column, order, updated. */
export const CardFrontmatterSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  column: z.string().min(1),
  order: z.string().min(1),
  updated: z.string().min(1),
  priority: z.string().optional(),
  labels: z.array(z.string()).optional().default([]),
  assignee: z.string().optional(),
  due: z.string().optional(),
  pr: z.string().optional(),
  branch: z.string().optional(),
});

export type CardFrontmatter = z.infer<typeof CardFrontmatterSchema>;

export type Card = {
  frontmatter: CardFrontmatter;
  status: string;
  log: string[];
};

export type CardParseError = {
  kind: "parse_error";
  message: string;
  cause?: unknown;
};

export type CardResult = { ok: true; card: Card } | { ok: false; error: CardParseError };

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

function extractSections(body: string): { status: string; log: string[] } {
  const statusMatch = body.match(/##\s*Status\s*\n([\s\S]*?)(?=\n##\s*Log\b|$)/i);
  const logMatch = body.match(/##\s*Log\s*\n([\s\S]*)$/i);

  const status = statusMatch ? statusMatch[1]!.trim() : "";
  const logBlock = logMatch ? logMatch[1]!.trim() : "";
  const log =
    logBlock.length === 0
      ? []
      : logBlock
          .split("\n")
          .map((line) => line.replace(/^-\s*/, "").trim())
          .filter((line) => line.length > 0);

  return { status, log };
}

/**
 * Parse a card markdown file. Never throws — returns a typed error on bad YAML/schema.
 */
export function parseCard(text: string): CardResult {
  try {
    const m = text.match(FRONTMATTER_RE);
    if (!m) {
      return {
        ok: false,
        error: {
          kind: "parse_error",
          message: "Missing YAML frontmatter delimiters (---)",
        },
      };
    }

    let raw: unknown;
    try {
      raw = parseYaml(m[1]!);
    } catch (cause) {
      return {
        ok: false,
        error: {
          kind: "parse_error",
          message: `Invalid YAML frontmatter: ${cause instanceof Error ? cause.message : String(cause)}`,
          cause,
        },
      };
    }

    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      return {
        ok: false,
        error: {
          kind: "parse_error",
          message: "Frontmatter must be a YAML mapping/object",
        },
      };
    }

    // Detect duplicate keys that yaml parser may have collapsed — we re-scan raw text
    const columnMatches = m[1]!.match(/^column\s*:/gm);
    if (columnMatches && columnMatches.length > 1) {
      return {
        ok: false,
        error: {
          kind: "parse_error",
          message: "Duplicate YAML key: column",
        },
      };
    }

    const validated = CardFrontmatterSchema.safeParse(raw);
    if (!validated.success) {
      return {
        ok: false,
        error: {
          kind: "parse_error",
          message: validated.error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; "),
          cause: validated.error,
        },
      };
    }

    const { status, log } = extractSections(m[2] ?? "");
    return {
      ok: true,
      card: {
        frontmatter: validated.data,
        status,
        log,
      },
    };
  } catch (cause) {
    return {
      ok: false,
      error: {
        kind: "parse_error",
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      },
    };
  }
}

/**
 * Serialize a card to markdown with YAML frontmatter + ## Status + ## Log.
 * Guarantees a single occurrence of each frontmatter key (never duplicate-keyed YAML).
 */
export function serializeCard(card: Card): string {
  const fm = card.frontmatter;
  // Build an ordered plain object so keys appear once
  const obj: Record<string, unknown> = {
    id: fm.id,
    title: fm.title,
    column: fm.column,
    order: fm.order,
  };
  if (fm.priority !== undefined) obj.priority = fm.priority;
  if (fm.labels && fm.labels.length > 0) obj.labels = fm.labels;
  if (fm.assignee !== undefined) obj.assignee = fm.assignee;
  if (fm.due !== undefined) obj.due = fm.due;
  if (fm.pr !== undefined) obj.pr = fm.pr;
  if (fm.branch !== undefined) obj.branch = fm.branch;
  obj.updated = fm.updated;

  const yaml = stringifyYaml(obj, { lineWidth: 0 }).trimEnd();
  const statusBody = card.status.length > 0 ? card.status : "";
  const logLines =
    card.log.length > 0 ? card.log.map((line) => `- ${line}`).join("\n") : "";

  return `---\n${yaml}\n---\n\n## Status\n${statusBody}\n\n## Log\n${logLines}\n`;
}

/** Count occurrences of a top-level YAML key in serialized frontmatter. */
export function countFrontmatterKey(text: string, key: string): number {
  const m = text.match(FRONTMATTER_RE);
  if (!m) return 0;
  const re = new RegExp(`^${key}\\s*:`, "gm");
  return (m[1]!.match(re) ?? []).length;
}
