/**
 * Optional HTTPS credential for git push/fetch.
 * Stored under .kanbanly/credentials.json (mode 0600) with AES-256-GCM encryption (NFR-6).
 * SSH remotes continue to use the agent — this is for PAT/HTTPS only.
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  createHash,
} from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export type GitCredential = {
  /** Usually "git" or "x-access-token" for GitHub PATs */
  username: string;
  /** PAT or password — never log or return to clients */
  token: string;
};

export type CredentialStoreFile = {
  username: string;
  /** Plaintext (legacy) or enc:v1:… ciphertext */
  token: string;
  updatedAt: string;
  encrypted?: boolean;
};

const ENC_PREFIX = "enc:v1:";
const ALGO = "aes-256-gcm";

export function defaultCredentialPath(repoPath: string): string {
  return join(repoPath, ".kanbanly", "credentials.json");
}

export function defaultCredentialKeyPath(repoPath: string): string {
  return join(repoPath, ".kanbanly", ".credential-key");
}

/**
 * Spec-aligned global store under ~/.kanbanly/ (NFR-6).
 * - credentials: ~/.kanbanly/credentials.json (encrypted payload)
 * - key: ~/.kanbanly/key
 */
export function globalKanbanlyDir(home = process.env.HOME ?? homedir()): string {
  return join(home, ".kanbanly");
}

export function globalCredentialPath(home?: string): string {
  return join(globalKanbanlyDir(home), "credentials.json");
}

export function globalCredentialKeyPath(home?: string): string {
  return join(globalKanbanlyDir(home), "key");
}

/**
 * Resolve 32-byte encryption key:
 * 1. KANBANLY_CREDENTIAL_KEY env (utf8, hashed to 32 bytes)
 * 2. Global ~/.kanbanly/key (spec layout)
 * 3. Per-repo .kanbanly/.credential-key
 * 4. Create global key when possible, else per-repo key
 */
export function resolveCredentialKey(
  repoPath: string,
  env: NodeJS.ProcessEnv = process.env,
  options?: { home?: string },
): Buffer {
  const fromEnv = env.KANBANLY_CREDENTIAL_KEY?.trim();
  if (fromEnv) {
    return createHash("sha256").update(fromEnv, "utf8").digest();
  }
  const candidates = [
    globalCredentialKeyPath(options?.home),
    defaultCredentialKeyPath(repoPath),
  ];
  for (const keyPath of candidates) {
    if (existsSync(keyPath)) {
      const raw = readFileSync(keyPath);
      if (raw.length >= 32) return Buffer.from(raw.subarray(0, 32));
    }
  }
  // Prefer writing global ~/.kanbanly/key (NFR-6 layout)
  let keyPath = globalCredentialKeyPath(options?.home);
  try {
    mkdirSync(dirname(keyPath), { recursive: true });
  } catch {
    keyPath = defaultCredentialKeyPath(repoPath);
    mkdirSync(dirname(keyPath), { recursive: true });
  }
  const derived = randomBytes(32);
  writeFileSync(keyPath, derived, { mode: 0o600 });
  try {
    chmodSync(keyPath, 0o600);
  } catch {
    /* ignore */
  }
  return derived;
}

function loadKeyFromFile(
  repoPath: string,
  env: NodeJS.ProcessEnv,
  home?: string,
): Buffer {
  return resolveCredentialKey(repoPath, env, { home });
}

/** Encrypt plaintext token → enc:v1:iv.tag.cipher (base64url parts). */
export function encryptToken(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return (
    ENC_PREFIX +
    [iv, tag, enc].map((b) => b.toString("base64url")).join(".")
  );
}

/** Decrypt enc:v1:… or return plaintext for legacy files. */
export function decryptToken(stored: string, key: Buffer): string {
  if (!stored.startsWith(ENC_PREFIX)) return stored;
  const parts = stored.slice(ENC_PREFIX.length).split(".");
  if (parts.length !== 3) throw new Error("invalid encrypted token format");
  const [ivB, tagB, dataB] = parts;
  const iv = Buffer.from(ivB!, "base64url");
  const tag = Buffer.from(tagB!, "base64url");
  const data = Buffer.from(dataB!, "base64url");
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString(
    "utf8",
  );
}

export function isEncryptedToken(stored: string): boolean {
  return stored.startsWith(ENC_PREFIX);
}

export class CredentialStore {
  readonly path: string;
  private repoPath: string;
  private env: NodeJS.ProcessEnv;
  private home?: string;

  constructor(
    path: string,
    options?: { env?: NodeJS.ProcessEnv; home?: string },
  ) {
    this.path = path;
    // repo root is parent of .kanbanly/ when path is …/repo/.kanbanly/credentials.json
    this.repoPath = dirname(dirname(path));
    this.env = options?.env ?? process.env;
    this.home = options?.home;
  }

  /** Global store at ~/.kanbanly/credentials.json */
  static global(options?: {
    env?: NodeJS.ProcessEnv;
    home?: string;
  }): CredentialStore {
    const home = options?.home ?? process.env.HOME ?? homedir();
    return new CredentialStore(globalCredentialPath(home), {
      env: options?.env,
      home,
    });
  }

  private key(): Buffer {
    return loadKeyFromFile(this.repoPath, this.env, this.home);
  }

  has(): boolean {
    return this.get() != null;
  }

  get(): GitCredential | null {
    try {
      if (!existsSync(this.path)) return null;
      const raw = JSON.parse(
        readFileSync(this.path, "utf8"),
      ) as CredentialStoreFile;
      if (!raw.token || typeof raw.token !== "string") return null;
      const token = decryptToken(raw.token, this.key());
      return {
        username: raw.username?.trim() || "x-access-token",
        token,
      };
    } catch {
      return null;
    }
  }

  /** Public status only — never includes the secret. */
  status(): {
    configured: boolean;
    username?: string;
    updatedAt?: string;
    encrypted?: boolean;
  } {
    try {
      if (!existsSync(this.path)) return { configured: false };
      const raw = JSON.parse(
        readFileSync(this.path, "utf8"),
      ) as CredentialStoreFile;
      if (!raw.token) return { configured: false };
      return {
        configured: true,
        username: raw.username || "x-access-token",
        updatedAt: raw.updatedAt,
        encrypted: isEncryptedToken(raw.token) || !!raw.encrypted,
      };
    } catch {
      return { configured: false };
    }
  }

  set(cred: { username?: string; token: string }): void {
    const token = cred.token.trim();
    if (!token) throw new Error("token is required");
    mkdirSync(dirname(this.path), { recursive: true });
    const key = this.key();
    const encrypted = encryptToken(token, key);
    const data: CredentialStoreFile = {
      username: (cred.username ?? "x-access-token").trim() || "x-access-token",
      token: encrypted,
      updatedAt: new Date().toISOString(),
      encrypted: true,
    };
    writeFileSync(this.path, JSON.stringify(data, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    try {
      chmodSync(this.path, 0o600);
    } catch {
      /* best-effort */
    }
  }

  clear(): void {
    try {
      if (existsSync(this.path)) unlinkSync(this.path);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Build env + askpass helper so git HTTPS can use a stored PAT without prompts.
 * Returns undefined when no credential is set.
 */
export function gitAuthEnv(
  cred: GitCredential | null | undefined,
  repoPath: string,
): Record<string, string> | undefined {
  if (!cred?.token) return undefined;
  const dir = join(repoPath, ".kanbanly");
  mkdirSync(dir, { recursive: true });
  const askpass = join(dir, "askpass.sh");
  const user = cred.username.replace(/'/g, `'\\''`);
  const pass = cred.token.replace(/'/g, `'\\''`);
  const script = `#!/bin/sh
case "$1" in
  *Username*|*username*) echo '${user}' ;;
  *) echo '${pass}' ;;
esac
`;
  writeFileSync(askpass, script, { encoding: "utf8", mode: 0o700 });
  try {
    chmodSync(askpass, 0o700);
  } catch {
    /* ignore */
  }
  return {
    GIT_ASKPASS: askpass,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.askPass",
    GIT_CONFIG_VALUE_0: askpass,
  };
}
