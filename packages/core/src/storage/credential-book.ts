/**
 * Named multi-credential book under ~/.kanbanly/credentials-book.json.
 * Tokens encrypted with the same key material as CredentialStore (NFR-6).
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
import {
  decryptToken,
  encryptToken,
  isEncryptedToken,
  resolveCredentialKey,
  type GitCredential,
} from "./credentials.ts";

export type CredentialBookEntry = {
  id: string;
  label: string;
  username: string;
  /** encrypted or legacy plaintext */
  token: string;
  updatedAt: string;
};

export type CredentialBookPublic = {
  id: string;
  label: string;
  username: string;
  updatedAt: string;
};

type BookFile = {
  credentials: CredentialBookEntry[];
  updatedAt: string;
};

export function credentialBookPath(
  home = process.env.HOME ?? homedir(),
): string {
  return join(home, ".kanbanly", "credentials-book.json");
}

function slugId(label: string): string {
  const s = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return s || `cred-${Date.now().toString(36)}`;
}

export class CredentialBook {
  readonly path: string;
  private home: string;
  private env: NodeJS.ProcessEnv;

  constructor(options?: { path?: string; home?: string; env?: NodeJS.ProcessEnv }) {
    this.home = options?.home ?? process.env.HOME ?? homedir();
    this.path = options?.path ?? credentialBookPath(this.home);
    this.env = options?.env ?? process.env;
  }

  private key(): Buffer {
    // Use home as "repo" path root for key resolution (global ~/.kanbanly/key)
    return resolveCredentialKey(this.home, this.env, { home: this.home });
  }

  private read(): BookFile {
    try {
      if (!existsSync(this.path)) {
        return { credentials: [], updatedAt: new Date().toISOString() };
      }
      const raw = JSON.parse(readFileSync(this.path, "utf8")) as BookFile;
      if (!Array.isArray(raw.credentials)) {
        return { credentials: [], updatedAt: new Date().toISOString() };
      }
      return raw;
    } catch {
      return { credentials: [], updatedAt: new Date().toISOString() };
    }
  }

  private write(file: BookFile): void {
    mkdirSync(dirname(this.path), { recursive: true });
    file.updatedAt = new Date().toISOString();
    writeFileSync(this.path, JSON.stringify(file, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    try {
      chmodSync(this.path, 0o600);
    } catch {
      /* best-effort */
    }
  }

  list(): CredentialBookPublic[] {
    return this.read().credentials.map((c) => ({
      id: c.id,
      label: c.label,
      username: c.username,
      updatedAt: c.updatedAt,
    }));
  }

  get(id: string): GitCredential | null {
    const entry = this.read().credentials.find((c) => c.id === id);
    if (!entry?.token) return null;
    try {
      return {
        username: entry.username || "x-access-token",
        token: decryptToken(entry.token, this.key()),
      };
    } catch {
      return null;
    }
  }

  /**
   * Create or update a named credential.
   * When updating without a new token, keeps existing secret.
   */
  upsert(input: {
    id?: string;
    label: string;
    username?: string;
    token?: string;
  }): CredentialBookPublic {
    const label = input.label.trim();
    if (!label) throw new Error("label is required");
    const file = this.read();
    let id = (input.id ?? slugId(label)).trim();
    if (!id) id = slugId(label);

    const existing = file.credentials.find((c) => c.id === id);
    const username =
      (input.username ?? existing?.username ?? "x-access-token").trim() ||
      "x-access-token";

    let tokenEnc: string;
    if (input.token?.trim()) {
      tokenEnc = encryptToken(input.token.trim(), this.key());
    } else if (existing?.token) {
      tokenEnc = existing.token;
    } else {
      throw new Error("token is required for new credentials");
    }

    const entry: CredentialBookEntry = {
      id,
      label,
      username,
      token: tokenEnc,
      updatedAt: new Date().toISOString(),
    };

    if (existing) {
      file.credentials = file.credentials.map((c) =>
        c.id === id ? entry : c,
      );
    } else {
      // unique id
      let n = 2;
      let unique = id;
      while (file.credentials.some((c) => c.id === unique)) {
        unique = `${id}-${n}`;
        n += 1;
      }
      entry.id = unique;
      file.credentials.push(entry);
    }
    this.write(file);
    return {
      id: entry.id,
      label: entry.label,
      username: entry.username,
      updatedAt: entry.updatedAt,
    };
  }

  remove(id: string): boolean {
    const file = this.read();
    const next = file.credentials.filter((c) => c.id !== id);
    if (next.length === file.credentials.length) return false;
    file.credentials = next;
    this.write(file);
    return true;
  }

  /** Debug/status without secrets. */
  status(): { count: number; encrypted: boolean } {
    const file = this.read();
    return {
      count: file.credentials.length,
      encrypted: file.credentials.every(
        (c) => !c.token || isEncryptedToken(c.token),
      ),
    };
  }
}
