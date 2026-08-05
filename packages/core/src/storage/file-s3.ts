import {
  createHash,
  randomBytes,
} from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import type { S3Client } from "./s3.ts";

/**
 * Filesystem-backed S3Client with ETag CAS.
 * One object per file under `rootDir`; etags stored in sidecar `.etag` files
 * (or derived from content hash for first write).
 *
 * Suitable for local SaaS / MinIO-less harness; same interface as production S3.
 */
export class FileS3Client implements S3Client {
  readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = rootDir;
    mkdirSync(rootDir, { recursive: true });
  }

  private objectPath(key: string): string {
    // Prevent path escape
    const safe = key.replace(/\.\./g, "").replace(/^\/+/, "");
    return join(this.rootDir, safe);
  }

  private etagPath(key: string): string {
    return this.objectPath(key) + ".etag";
  }

  private metaPath(key: string): string {
    return this.objectPath(key) + ".meta.json";
  }

  private readEtag(key: string): string | null {
    const p = this.etagPath(key);
    if (!existsSync(p)) return null;
    return readFileSync(p, "utf8").trim();
  }

  private writeEtag(key: string, etag: string): void {
    const p = this.etagPath(key);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, etag, "utf8");
  }

  private newEtag(body: string): string {
    const hash = createHash("sha256").update(body).digest("hex").slice(0, 16);
    const nonce = randomBytes(4).toString("hex");
    return `"${hash}-${nonce}"`;
  }

  async get(key: string): Promise<{ body: string; etag: string } | null> {
    const path = this.objectPath(key);
    if (!existsSync(path) || !statSync(path).isFile()) return null;
    const body = readFileSync(path, "utf8");
    let etag = this.readEtag(key);
    if (!etag) {
      etag = this.newEtag(body);
      this.writeEtag(key, etag);
    }
    return { body, etag };
  }

  async put(
    key: string,
    body: string,
    options?: { ifMatch?: string },
  ): Promise<{ etag: string } | { conflict: true; etag?: string }> {
    const path = this.objectPath(key);
    const existingEtag = existsSync(path) ? this.readEtag(key) : null;

    if (options?.ifMatch !== undefined) {
      if (!existingEtag || existingEtag !== options.ifMatch) {
        return { conflict: true, etag: existingEtag ?? undefined };
      }
    }

    mkdirSync(dirname(path), { recursive: true });
    // Atomic-ish write via temp + rename
    const tmp = path + `.tmp-${randomBytes(4).toString("hex")}`;
    writeFileSync(tmp, body, "utf8");
    renameSync(tmp, path);
    const etag = this.newEtag(body);
    this.writeEtag(key, etag);

    // Optional meta for versioning-ish debugging
    writeFileSync(
      this.metaPath(key),
      JSON.stringify({ key, etag, updated: new Date().toISOString() }) + "\n",
      "utf8",
    );
    return { etag };
  }

  async list(prefix: string): Promise<Array<{ key: string; etag: string }>> {
    const out: Array<{ key: string; etag: string }> = [];
    const walk = (dir: string) => {
      if (!existsSync(dir)) return;
      for (const name of readdirSync(dir)) {
        if (name.endsWith(".etag") || name.endsWith(".meta.json") || name.includes(".tmp-")) {
          continue;
        }
        const full = join(dir, name);
        const st = statSync(full);
        if (st.isDirectory()) {
          walk(full);
        } else if (st.isFile()) {
          const key = relative(this.rootDir, full).split("\\").join("/");
          if (key.startsWith(prefix) || prefix === "" || key.startsWith(prefix.replace(/\/$/, ""))) {
            const etag = this.readEtag(key) ?? `"missing"`;
            out.push({ key, etag });
          }
        }
      }
    };
    walk(this.rootDir);
    // Also match prefix filter precisely
    return out.filter((o) => o.key.startsWith(prefix));
  }

  async delete(key: string): Promise<void> {
    const path = this.objectPath(key);
    if (existsSync(path)) unlinkSync(path);
    const e = this.etagPath(key);
    if (existsSync(e)) unlinkSync(e);
    const m = this.metaPath(key);
    if (existsSync(m)) unlinkSync(m);
  }
}
