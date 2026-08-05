import { parse as parseYaml } from "yaml";
import { z } from "zod";

export const BoardColumnSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
});

export const BoardSchema = z.object({
  columns: z.array(BoardColumnSchema).min(1),
  labels: z
    .array(
      z.union([
        z.string(),
        z.object({ id: z.string(), name: z.string().optional(), color: z.string().optional() }),
      ]),
    )
    .optional()
    .default([]),
  settings: z.record(z.unknown()).optional().default({}),
});

export type BoardColumn = z.infer<typeof BoardColumnSchema>;
export type Board = z.infer<typeof BoardSchema>;

export type BoardParseError = {
  kind: "board_parse_error";
  message: string;
  cause?: unknown;
};

export type BoardResult =
  | { ok: true; board: Board }
  | { ok: false; error: BoardParseError };

/**
 * Parse board.yml text. Duplicate column ids → validation error.
 */
export function parseBoard(text: string): BoardResult {
  try {
    let raw: unknown;
    try {
      raw = parseYaml(text);
    } catch (cause) {
      return {
        ok: false,
        error: {
          kind: "board_parse_error",
          message: `Invalid YAML: ${cause instanceof Error ? cause.message : String(cause)}`,
          cause,
        },
      };
    }

    // Support both `{ columns: [...] }` and a bare array of columns
    let candidate = raw;
    if (Array.isArray(raw)) {
      candidate = { columns: raw, labels: [], settings: {} };
    }

    const validated = BoardSchema.safeParse(candidate);
    if (!validated.success) {
      return {
        ok: false,
        error: {
          kind: "board_parse_error",
          message: validated.error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; "),
          cause: validated.error,
        },
      };
    }

    const ids = validated.data.columns.map((c) => c.id);
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    if (dupes.length > 0) {
      return {
        ok: false,
        error: {
          kind: "board_parse_error",
          message: `Duplicate column ids: ${[...new Set(dupes)].join(", ")}`,
        },
      };
    }

    return { ok: true, board: validated.data };
  } catch (cause) {
    return {
      ok: false,
      error: {
        kind: "board_parse_error",
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      },
    };
  }
}

/** Flag cards whose column id is not in the board definition (do not drop them). */
export function flagUnknownColumns(
  board: Board,
  cards: Array<{ id: string; column: string }>,
): Array<{ id: string; column: string; known: boolean }> {
  const known = new Set(board.columns.map((c) => c.id));
  return cards.map((c) => ({
    id: c.id,
    column: c.column,
    known: known.has(c.column),
  }));
}

/** Default starter board.yml content. */
export function defaultBoardYaml(): string {
  return `columns:
  - id: backlog
    name: Backlog
  - id: doing
    name: Doing
  - id: review
    name: Review
  - id: done
    name: Done
labels: []
settings: {}
`;
}
