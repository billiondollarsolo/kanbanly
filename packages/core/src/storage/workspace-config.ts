/**
 * Persistent workspace config: connection defaults + per-board bindings
 * (credential choice, board dir, remote slug).
 *
 * Path: ~/.kanbanly/workspace.json
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export type ConnectionConfig = {
  /** Usually remote registry slug */
  id: string;
  label: string;
  localPath: string;
  remoteUrl: string | null;
  /** Default credential from CredentialBook for this connection */
  defaultCredentialId?: string | null;
};

export type BoardBinding = {
  /** `${remoteSlug}::${boardId}` */
  key: string;
  boardId: string;
  /** Layout A board directory id, or "." for layout B */
  boardDir: string;
  remoteSlug: string;
  /** Override connection default credential */
  credentialId?: string | null;
  label?: string;
};

export type WorkspaceFile = {
  connections: ConnectionConfig[];
  boards: BoardBinding[];
  updatedAt: string;
};

export function workspaceConfigPath(
  home = process.env.HOME ?? homedir(),
): string {
  return join(home, ".kanbanly", "workspace.json");
}

export function boardBindingKey(remoteSlug: string, boardId: string): string {
  return `${remoteSlug}::${boardId}`;
}

export class WorkspaceConfig {
  readonly path: string;

  constructor(options?: { path?: string; home?: string }) {
    const home = options?.home ?? process.env.HOME ?? homedir();
    this.path = options?.path ?? workspaceConfigPath(home);
  }

  private read(): WorkspaceFile {
    try {
      if (!existsSync(this.path)) {
        return {
          connections: [],
          boards: [],
          updatedAt: new Date().toISOString(),
        };
      }
      const raw = JSON.parse(readFileSync(this.path, "utf8")) as WorkspaceFile;
      return {
        connections: Array.isArray(raw.connections) ? raw.connections : [],
        boards: Array.isArray(raw.boards) ? raw.boards : [],
        updatedAt: raw.updatedAt ?? new Date().toISOString(),
      };
    } catch {
      return {
        connections: [],
        boards: [],
        updatedAt: new Date().toISOString(),
      };
    }
  }

  private write(file: WorkspaceFile): void {
    mkdirSync(dirname(this.path), { recursive: true });
    file.updatedAt = new Date().toISOString();
    writeFileSync(this.path, JSON.stringify(file, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    try {
      chmodSync(this.path, 0o600);
    } catch {
      /* ignore */
    }
  }

  get(): WorkspaceFile {
    return this.read();
  }

  upsertConnection(conn: ConnectionConfig): ConnectionConfig {
    const file = this.read();
    const i = file.connections.findIndex((c) => c.id === conn.id);
    if (i >= 0) file.connections[i] = { ...file.connections[i], ...conn };
    else file.connections.push(conn);
    this.write(file);
    return conn;
  }

  removeConnection(id: string): boolean {
    const file = this.read();
    const next = file.connections.filter((c) => c.id !== id);
    if (next.length === file.connections.length) return false;
    file.connections = next;
    // drop board bindings for that remote
    file.boards = file.boards.filter((b) => b.remoteSlug !== id);
    this.write(file);
    return true;
  }

  upsertBoard(binding: BoardBinding): BoardBinding {
    const file = this.read();
    const key =
      binding.key || boardBindingKey(binding.remoteSlug, binding.boardId);
    const full: BoardBinding = {
      ...binding,
      key,
      boardDir: binding.boardDir || binding.boardId,
    };
    const i = file.boards.findIndex((b) => b.key === key);
    if (i >= 0) file.boards[i] = { ...file.boards[i], ...full };
    else file.boards.push(full);
    this.write(file);
    return full;
  }

  getBoard(remoteSlug: string, boardId: string): BoardBinding | null {
    const key = boardBindingKey(remoteSlug, boardId);
    return this.read().boards.find((b) => b.key === key) ?? null;
  }

  removeBoard(remoteSlug: string, boardId: string): boolean {
    const key = boardBindingKey(remoteSlug, boardId);
    const file = this.read();
    const next = file.boards.filter((b) => b.key !== key);
    if (next.length === file.boards.length) return false;
    file.boards = next;
    this.write(file);
    return true;
  }

  /**
   * Resolve which credential id applies for a board:
   * board override → connection default → null (use legacy/repo store)
   */
  resolveCredentialId(
    remoteSlug: string,
    boardId: string,
  ): string | null {
    const file = this.read();
    const board = file.boards.find(
      (b) => b.remoteSlug === remoteSlug && b.boardId === boardId,
    );
    if (board?.credentialId) return board.credentialId;
    const conn = file.connections.find((c) => c.id === remoteSlug);
    return conn?.defaultCredentialId ?? null;
  }
}
