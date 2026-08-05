import { describe, expect, test } from "bun:test";
import {
  ALL_AI_TOOLS,
  WRITE_TOOLS,
  WriteConfirmGate,
  toolToJsonSchema,
} from "../src/ai-tools.ts";

describe("AI tool definitions", () => {
  test("all write tools require confirm", () => {
    expect(WRITE_TOOLS.length).toBeGreaterThan(0);
    for (const t of WRITE_TOOLS) {
      expect(t.requiresConfirm).toBe(true);
      expect(t.kind).toBe("write");
    }
  });

  test("read tools do not require confirm", () => {
    for (const t of ALL_AI_TOOLS.filter((x) => x.kind === "read")) {
      expect(t.requiresConfirm).toBe(false);
    }
  });

  test("WriteConfirmGate blocks write until confirmed", () => {
    const gate = new WriteConfirmGate();
    let committed = false;

    const first = gate.tryExecute("create_card", { title: "X" }, undefined, () => {
      committed = true;
      return { id: "c-1" };
    });
    expect(first.gated).toBe(true);
    expect(committed).toBe(false);
    if (!first.gated) return;

    // Without confirm, same token still gated
    const second = gate.tryExecute("create_card", { title: "X" }, first.token, () => {
      committed = true;
      return { id: "c-1" };
    });
    expect(second.gated).toBe(true);
    expect(committed).toBe(false);

    // Confirm then execute
    expect(gate.confirm(first.token)).toBe(true);
    const third = gate.tryExecute("create_card", { title: "X" }, first.token, () => {
      committed = true;
      return { id: "c-1" };
    });
    expect(third.gated).toBe(false);
    expect(committed).toBe(true);
    if (third.gated) return;
    expect(third.result).toEqual({ id: "c-1" });
  });

  test("read tools execute immediately", () => {
    const gate = new WriteConfirmGate();
    const r = gate.tryExecute("list_cards", { boardId: "b" }, undefined, () => {
      return [{ id: "c-1" }];
    });
    expect(r.gated).toBe(false);
    if (r.gated) return;
    expect(r.result).toEqual([{ id: "c-1" }]);
  });

  test("toolToJsonSchema exports names", () => {
    for (const t of ALL_AI_TOOLS) {
      const s = toolToJsonSchema(t);
      expect(s.name).toBe(t.name);
      expect(s.parameters.length).toBeGreaterThan(0);
    }
  });
});
