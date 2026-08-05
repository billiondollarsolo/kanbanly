import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import { slugifyTitle } from "./id.ts";

export const BoardColumnSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
});

export const BoardSchema = z.object({
  /** Optional stable id (directory name is source of truth when present on disk). */
  id: z.string().min(1).optional(),
  /** Human display title (preferred over directory name in UI). */
  title: z.string().min(1).optional(),
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

/** Stable column id from a display name (`Blocked` → `blocked`). */
export function slugifyColumnId(name: string): string {
  return slugifyTitle(name, 40);
}

/**
 * Append a column to a board definition.
 * - `id` optional; derived from name via slugify when omitted
 * - Rejects blank names and duplicate ids
 */
export function appendColumn(
  board: Board,
  input: { name: string; id?: string },
):
  | { ok: true; board: Board; column: BoardColumn }
  | { ok: false; error: string } {
  const name = input.name.trim();
  if (!name) return { ok: false, error: "Column name is required" };

  let id = (input.id ?? slugifyColumnId(name)).trim().toLowerCase();
  id = id.replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!id) return { ok: false, error: "Column id is empty after slugify" };

  const existing = new Set(board.columns.map((c) => c.id));
  if (existing.has(id)) {
    // Auto-suffix when name collides (e.g. second "Done")
    let n = 2;
    while (existing.has(`${id}-${n}`)) n++;
    id = `${id}-${n}`;
  }

  const column: BoardColumn = { id, name };
  return {
    ok: true,
    board: {
      ...board,
      columns: [...board.columns, column],
      labels: board.labels ?? [],
      settings: board.settings ?? {},
    },
    column,
  };
}

/**
 * Rename a column's display name (id stays stable so cards keep working).
 */
export function renameColumn(
  board: Board,
  columnId: string,
  name: string,
):
  | { ok: true; board: Board; column: BoardColumn }
  | { ok: false; error: string } {
  const trimmed = name.trim();
  if (!trimmed) return { ok: false, error: "Column name is required" };
  const idx = board.columns.findIndex((c) => c.id === columnId);
  if (idx < 0) return { ok: false, error: `Unknown column: ${columnId}` };
  const columns = board.columns.map((c, i) =>
    i === idx ? { id: c.id, name: trimmed } : c,
  );
  const column = columns[idx]!;
  return {
    ok: true,
    board: {
      ...board,
      columns,
      labels: board.labels ?? [],
      settings: board.settings ?? {},
    },
    column,
  };
}

/**
 * Reorder columns to match `orderedIds` (must be a permutation of current ids).
 */
export function reorderColumns(
  board: Board,
  orderedIds: string[],
): { ok: true; board: Board } | { ok: false; error: string } {
  if (orderedIds.length !== board.columns.length) {
    return {
      ok: false,
      error: `Expected ${board.columns.length} column ids, got ${orderedIds.length}`,
    };
  }
  const byId = new Map(board.columns.map((c) => [c.id, c]));
  if (new Set(orderedIds).size !== orderedIds.length) {
    return { ok: false, error: "Duplicate column id in order" };
  }
  const columns: BoardColumn[] = [];
  for (const id of orderedIds) {
    const col = byId.get(id);
    if (!col) return { ok: false, error: `Unknown column in order: ${id}` };
    columns.push(col);
  }
  return {
    ok: true,
    board: {
      ...board,
      columns,
      labels: board.labels ?? [],
      settings: board.settings ?? {},
    },
  };
}

/**
 * Remove a column from the board definition.
 * Cards are not modified here — caller must remapped/archive them first if needed.
 * Refuses to remove the last column.
 */
export function removeColumn(
  board: Board,
  columnId: string,
): { ok: true; board: Board } | { ok: false; error: string } {
  if (!board.columns.some((c) => c.id === columnId)) {
    return { ok: false, error: `Unknown column: ${columnId}` };
  }
  if (board.columns.length <= 1) {
    return { ok: false, error: "Cannot delete the last column" };
  }
  return {
    ok: true,
    board: {
      ...board,
      columns: board.columns.filter((c) => c.id !== columnId),
      labels: board.labels ?? [],
      settings: board.settings ?? {},
    },
  };
}

/** Layout-A board directory id from a display name (`Mobile App` → `mobile-app`). */
export function slugifyBoardId(name: string): string {
  return slugifyTitle(name, 48);
}

/** Serialize board config to YAML (round-trips with parseBoard). */
export function serializeBoard(board: Board): string {
  const obj: Record<string, unknown> = {};
  if (board.id) obj.id = board.id;
  if (board.title) obj.title = board.title;
  obj.columns = board.columns.map((c) => ({ id: c.id, name: c.name }));
  if (board.labels && board.labels.length > 0) {
    obj.labels = board.labels;
  } else {
    obj.labels = [];
  }
  obj.settings =
    board.settings && Object.keys(board.settings).length > 0
      ? board.settings
      : {};
  return stringifyYaml(obj, { lineWidth: 0 }).trimEnd() + "\n";
}

/** Display label for a board: explicit title, else id. */
export function boardDisplayTitle(
  board: Pick<Board, "title" | "id">,
  fallbackId: string,
): string {
  return board.title?.trim() || board.id?.trim() || fallbackId;
}

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

/**
 * Default project columns for multi-agent pickup.
 * Inbox = human brain dump; Ready = groomed for agents; agents only start from Ready / assigned Doing.
 */
export const DEFAULT_PROJECT_COLUMNS: BoardColumn[] = [
  { id: "inbox", name: "Inbox" },
  { id: "ready", name: "Ready" },
  { id: "doing", name: "Doing" },
  { id: "blocked", name: "Blocked" },
  { id: "review", name: "Review" },
  { id: "done", name: "Done" },
];

/** Suggested WIP for Doing (agents + humans). Stored in board settings. */
export const DEFAULT_WIP_DOING = 3;

/** Default starter board.yml content. */
export function defaultBoardYaml(options?: {
  title?: string;
  id?: string;
  /** Use legacy backlog/doing/review/done (tests/fixtures). Default: project template. */
  legacyColumns?: boolean;
}): string {
  const columns = options?.legacyColumns
    ? [
        { id: "backlog", name: "Backlog" },
        { id: "doing", name: "Doing" },
        { id: "review", name: "Review" },
        { id: "done", name: "Done" },
      ]
    : DEFAULT_PROJECT_COLUMNS;
  return serializeBoard({
    id: options?.id,
    title: options?.title,
    columns,
    labels: [],
    settings: options?.legacyColumns
      ? {}
      : {
          wipDoing: DEFAULT_WIP_DOING,
          /** Soft by default; set wipHard: true for unattended fleets */
          wipHard: false,
          agentPickup: ["ready", "doing"],
        },
  });
}
