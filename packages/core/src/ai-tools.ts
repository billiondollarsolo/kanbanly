import { z } from "zod";
import type { Card } from "./card.ts";
import { CardFrontmatterSchema } from "./card.ts";

/**
 * AI tool definitions for SaaS (and any consumer).
 * Write tools require confirm-before-commit — the runtime must set
 * `requiresConfirm: true` and only execute after an in-chat confirm chip.
 */

export type ToolKind = "read" | "write";

export type AiToolDefinition = {
  name: string;
  description: string;
  kind: ToolKind;
  /** Write tools MUST be true — gate fires before commit. */
  requiresConfirm: boolean;
  parameters: z.ZodTypeAny;
};

export const listCardsTool: AiToolDefinition = {
  name: "list_cards",
  description: "List cards on a board, optionally filtered by column",
  kind: "read",
  requiresConfirm: false,
  parameters: z.object({
    boardId: z.string(),
    column: z.string().optional(),
  }),
};

export const getCardTool: AiToolDefinition = {
  name: "get_card",
  description: "Get a single card by id",
  kind: "read",
  requiresConfirm: false,
  parameters: z.object({
    boardId: z.string(),
    cardId: z.string(),
  }),
};

export const boardSummaryTool: AiToolDefinition = {
  name: "board_summary",
  description: "Summarize board columns and card counts",
  kind: "read",
  requiresConfirm: false,
  parameters: z.object({
    boardId: z.string(),
  }),
};

export const searchCardsTool: AiToolDefinition = {
  name: "search_cards",
  description: "Search cards by free text, label, or assignee",
  kind: "read",
  requiresConfirm: false,
  parameters: z.object({
    boardId: z.string(),
    query: z.string(),
    label: z.string().optional(),
    assignee: z.string().optional(),
  }),
};

export const cardHistoryTool: AiToolDefinition = {
  name: "card_history",
  description: "Return the ## Log history for a card",
  kind: "read",
  requiresConfirm: false,
  parameters: z.object({
    boardId: z.string(),
    cardId: z.string(),
  }),
};

export const getNotesTool: AiToolDefinition = {
  name: "get_notes",
  description:
    "Read project NOTES.md for a board (intent, decisions, agent standing orders)",
  kind: "read",
  requiresConfirm: false,
  parameters: z.object({
    boardId: z.string(),
  }),
};

export const listProjectCommitsTool: AiToolDefinition = {
  name: "list_project_commits",
  description:
    "List recent commits from the board's bound **source code** repo (not boards-repo chore commits)",
  kind: "read",
  requiresConfirm: false,
  parameters: z.object({
    boardId: z.string(),
    limit: z.number().int().positive().max(200).optional(),
  }),
};

export const setCodeBindingTool: AiToolDefinition = {
  name: "set_code_binding",
  description:
    "Bind a board to a source/code repo (local path and/or remote URL). Server may clone the remote into ~/.kanbanly/code-clones.",
  kind: "write",
  requiresConfirm: true,
  parameters: z.object({
    boardId: z.string(),
    path: z.string().optional(),
    remote: z.string().optional(),
    clear: z.boolean().optional(),
  }),
};

export const updateNotesTool: AiToolDefinition = {
  name: "update_notes",
  description: "Write project NOTES.md for a board (durable decisions/risks)",
  kind: "write",
  requiresConfirm: true,
  parameters: z.object({
    boardId: z.string(),
    body: z.string(),
  }),
};

export const sessionEndTool: AiToolDefinition = {
  name: "session_end",
  description:
    "Unattended fleet: append session-end Log (+ optional Status/SHA). Required before long agent run finishes.",
  kind: "write",
  requiresConfirm: true,
  parameters: z.object({
    boardId: z.string(),
    cardId: z.string(),
    summary: z.string().min(1),
    agent: z.string().optional(),
    status: z.string().optional(),
    sha: z.string().optional(),
  }),
};

export const fleetHealthTool: AiToolDefinition = {
  name: "fleet_health",
  description:
    "Unattended fleet: list high-priority board issues (stale Doing, P0, silent pulse, WIP over)",
  kind: "read",
  requiresConfirm: false,
  parameters: z.object({
    staleHours: z.number().optional(),
    silentHours: z.number().optional(),
  }),
};

export const createCardTool: AiToolDefinition = {
  name: "create_card",
  description: "Create a new card with a title in a column",
  kind: "write",
  requiresConfirm: true,
  parameters: z.object({
    boardId: z.string(),
    title: z.string().min(1),
    column: z.string().min(1),
  }),
};

export const moveCardTool: AiToolDefinition = {
  name: "move_card",
  description: "Move a card to another column",
  kind: "write",
  requiresConfirm: true,
  parameters: z.object({
    boardId: z.string(),
    cardId: z.string(),
    toColumn: z.string(),
  }),
};

export const updateStatusTool: AiToolDefinition = {
  name: "update_status",
  description: "Overwrite the ## Status section of a card",
  kind: "write",
  requiresConfirm: true,
  parameters: z.object({
    boardId: z.string(),
    cardId: z.string(),
    status: z.string(),
  }),
};

export const addLabelTool: AiToolDefinition = {
  name: "add_label",
  description: "Add a label to a card",
  kind: "write",
  requiresConfirm: true,
  parameters: z.object({
    boardId: z.string(),
    cardId: z.string(),
    label: z.string(),
  }),
};

export const ALL_AI_TOOLS: AiToolDefinition[] = [
  listCardsTool,
  getCardTool,
  boardSummaryTool,
  searchCardsTool,
  cardHistoryTool,
  getNotesTool,
  listProjectCommitsTool,
  fleetHealthTool,
  setCodeBindingTool,
  updateNotesTool,
  sessionEndTool,
  createCardTool,
  moveCardTool,
  updateStatusTool,
  addLabelTool,
];

export const WRITE_TOOLS = ALL_AI_TOOLS.filter((t) => t.kind === "write");
export const READ_TOOLS = ALL_AI_TOOLS.filter((t) => t.kind === "read");

/**
 * Runtime gate: write tools may not commit until confirmed.
 * Returns { allowed: false } until confirm() is called with matching token.
 */
export class WriteConfirmGate {
  private pending = new Map<
    string,
    { tool: string; args: unknown; confirmed: boolean }
  >();

  request(toolName: string, args: unknown): { token: string; requiresConfirm: true } {
    const def = ALL_AI_TOOLS.find((t) => t.name === toolName);
    if (!def || def.kind !== "write") {
      throw new Error(`${toolName} is not a write tool`);
    }
    if (!def.requiresConfirm) {
      throw new Error(`${toolName} must have requiresConfirm=true`);
    }
    const token = `confirm-${toolName}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.pending.set(token, { tool: toolName, args, confirmed: false });
    return { token, requiresConfirm: true };
  }

  confirm(token: string): boolean {
    const p = this.pending.get(token);
    if (!p) return false;
    p.confirmed = true;
    return true;
  }

  /**
   * Attempt to execute. Fires the gate if not confirmed.
   * Returns { gated: true, token } when confirm is required and not yet given.
   */
  tryExecute<T>(
    toolName: string,
    args: unknown,
    token: string | undefined,
    execute: (args: unknown) => T,
  ): { gated: true; token: string } | { gated: false; result: T } {
    const def = ALL_AI_TOOLS.find((t) => t.name === toolName);
    if (!def) throw new Error(`Unknown tool: ${toolName}`);

    if (def.kind === "read") {
      return { gated: false, result: execute(args) };
    }

    if (!token) {
      const req = this.request(toolName, args);
      return { gated: true, token: req.token };
    }

    const p = this.pending.get(token);
    if (!p || !p.confirmed || p.tool !== toolName) {
      return { gated: true, token };
    }

    const result = execute(args);
    this.pending.delete(token);
    return { gated: false, result };
  }
}

/** JSON Schema-ish export of tool params for TanStack AI toolDefinition. */
export function toolToJsonSchema(tool: AiToolDefinition): {
  name: string;
  description: string;
  requiresConfirm: boolean;
  kind: ToolKind;
  // Zod shape keys for documentation
  parameters: string[];
} {
  // Extract keys from Zod object if possible
  let parameters: string[] = [];
  if (tool.parameters instanceof z.ZodObject) {
    parameters = Object.keys(tool.parameters.shape);
  }
  return {
    name: tool.name,
    description: tool.description,
    requiresConfirm: tool.requiresConfirm,
    kind: tool.kind,
    parameters,
  };
}

// Re-export schema so SaaS can validate card shapes from core
export { CardFrontmatterSchema };
export type { Card };
