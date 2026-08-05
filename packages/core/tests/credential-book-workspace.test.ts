import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CredentialBook } from "../src/storage/credential-book.ts";
import {
  WorkspaceConfig,
  boardBindingKey,
} from "../src/storage/workspace-config.ts";

describe("CredentialBook + WorkspaceConfig", () => {
  test("stores multiple encrypted credentials and resolves board override", () => {
    const home = mkdtempSync(join(tmpdir(), "kb-ws-"));
    const book = new CredentialBook({ home });
    const work = book.upsert({
      label: "Work",
      token: "ghp_work_token_secret",
      username: "x-access-token",
    });
    const personal = book.upsert({
      label: "Personal",
      token: "ghp_personal_token_secret",
    });
    expect(book.list()).toHaveLength(2);
    expect(book.get(work.id)?.token).toBe("ghp_work_token_secret");
    expect(book.get(personal.id)?.token).toBe("ghp_personal_token_secret");

    const ws = new WorkspaceConfig({ home });
    ws.upsertConnection({
      id: "boards",
      label: "boards",
      localPath: "/tmp/boards",
      remoteUrl: "https://github.com/acme/boards.git",
      defaultCredentialId: work.id,
    });
    ws.upsertBoard({
      key: boardBindingKey("boards", "backend"),
      boardId: "backend",
      boardDir: "backend",
      remoteSlug: "boards",
      credentialId: personal.id,
      label: "Backend",
    });
    ws.upsertBoard({
      key: boardBindingKey("boards", "web"),
      boardId: "web",
      boardDir: "web",
      remoteSlug: "boards",
      label: "Web",
    });

    expect(ws.resolveCredentialId("boards", "backend")).toBe(personal.id);
    expect(ws.resolveCredentialId("boards", "web")).toBe(work.id);
    expect(ws.getBoard("boards", "backend")?.boardDir).toBe("backend");
  });
});
