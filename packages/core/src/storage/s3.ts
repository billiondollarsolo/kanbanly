import { parseCard, serializeCard, type Card } from "../card.ts";
import { cardFilename } from "../id.ts";
import { parseBoard, type Board } from "../board.ts";
import type {
  BoardStorage,
  BoardSummary,
  CardRef,
  StorageResult,
} from "./types.ts";

/**
 * Minimal S3-like object store interface for CAS (conditional writes).
 * Production uses AWS S3; tests use InMemoryS3.
 */
export interface S3Client {
  get(key: string): Promise<{ body: string; etag: string } | null>;
  put(
    key: string,
    body: string,
    options?: { ifMatch?: string },
  ): Promise<{ etag: string } | { conflict: true; etag?: string }>;
  list(prefix: string): Promise<Array<{ key: string; etag: string }>>;
  delete?(key: string): Promise<void>;
}

/** In-memory S3 for tests and local SaaS harness. */
export class InMemoryS3 implements S3Client {
  private objects = new Map<string, { body: string; etag: string; version: number }>();
  private seq = 0;

  private nextEtag(): string {
    this.seq += 1;
    return `"etag-${this.seq}"`;
  }

  async get(key: string) {
    const o = this.objects.get(key);
    if (!o) return null;
    return { body: o.body, etag: o.etag };
  }

  async put(
    key: string,
    body: string,
    options?: { ifMatch?: string },
  ): Promise<{ etag: string } | { conflict: true; etag?: string }> {
    const existing = this.objects.get(key);
    if (options?.ifMatch !== undefined) {
      if (!existing || existing.etag !== options.ifMatch) {
        return { conflict: true, etag: existing?.etag };
      }
    }
    const etag = this.nextEtag();
    this.objects.set(key, {
      body,
      etag,
      version: (existing?.version ?? 0) + 1,
    });
    return { etag };
  }

  async list(prefix: string) {
    const out: Array<{ key: string; etag: string }> = [];
    for (const [key, o] of this.objects) {
      if (key.startsWith(prefix)) out.push({ key, etag: o.etag });
    }
    return out;
  }

  async delete(key: string) {
    this.objects.delete(key);
  }

  /** Test helper: dump all objects. */
  dump(): Map<string, { body: string; etag: string; version: number }> {
    return new Map(this.objects);
  }
}

export type S3StorageOptions = {
  client: S3Client;
  /** Key prefix, e.g. tenants/acme/boards */
  prefix: string;
};

/**
 * S3 storage: one object per card, git-identical markdown format.
 * Write path: GET → ETag → PUT with If-Match → 412 retry.
 */
export class S3Storage implements BoardStorage {
  private client: S3Client;
  private prefix: string;

  constructor(options: S3StorageOptions) {
    this.client = options.client;
    this.prefix = options.prefix.replace(/\/$/, "");
  }

  private boardKey(boardId: string): string {
    return `${this.prefix}/${boardId}/board.yml`;
  }

  private cardKey(boardId: string, filename: string): string {
    return `${this.prefix}/${boardId}/cards/${filename}`;
  }

  private cardsPrefix(boardId: string): string {
    return `${this.prefix}/${boardId}/cards/`;
  }

  async listBoards(): Promise<StorageResult<BoardSummary[]>> {
    const objects = await this.client.list(`${this.prefix}/`);
    const boardIds = new Set<string>();
    for (const o of objects) {
      const rest = o.key.slice(this.prefix.length + 1);
      const parts = rest.split("/");
      if (parts[1] === "board.yml" || parts[0] === "board.yml") {
        boardIds.add(parts[0] === "board.yml" ? "." : parts[0]!);
      }
    }
    return {
      ok: true,
      value: [...boardIds].map((id) => ({ id, path: id })),
    };
  }

  async readBoard(boardId: string): Promise<StorageResult<Board>> {
    const obj = await this.client.get(this.boardKey(boardId));
    if (!obj) return { ok: false, error: { kind: "not_found", path: this.boardKey(boardId) } };
    const parsed = parseBoard(obj.body);
    if (!parsed.ok) {
      return { ok: false, error: { kind: "io", message: parsed.error.message } };
    }
    return { ok: true, value: parsed.board };
  }

  async putBoard(boardId: string, yaml: string): Promise<StorageResult<{ etag: string }>> {
    const r = await this.client.put(this.boardKey(boardId), yaml);
    if ("conflict" in r) {
      return { ok: false, error: { kind: "cas_failed", message: "board put conflict", etag: r.etag } };
    }
    return { ok: true, value: { etag: r.etag } };
  }

  async listCards(boardId: string): Promise<StorageResult<CardRef[]>> {
    const objects = await this.client.list(this.cardsPrefix(boardId));
    const refs: CardRef[] = [];
    for (const o of objects) {
      const filename = o.key.split("/").pop()!;
      if (!filename.endsWith(".md")) continue;
      const idMatch = filename.match(/^(c-[a-z0-9]+)-/i);
      if (!idMatch) continue;
      refs.push({
        id: idMatch[1]!,
        filename,
        path: o.key,
      });
    }
    return { ok: true, value: refs };
  }

  async readCard(boardId: string, cardId: string): Promise<StorageResult<Card & { etag?: string }>> {
    const listed = await this.listCards(boardId);
    if (!listed.ok) return listed;
    const ref = listed.value.find((c) => c.id === cardId);
    if (!ref) return { ok: false, error: { kind: "not_found", path: cardId } };
    const obj = await this.client.get(ref.path);
    if (!obj) return { ok: false, error: { kind: "not_found", path: ref.path } };
    const parsed = parseCard(obj.body);
    if (!parsed.ok) {
      return { ok: false, error: { kind: "io", message: parsed.error.message } };
    }
    return { ok: true, value: { ...parsed.card, etag: obj.etag } };
  }

  /**
   * Conditional write: GET → If-Match PUT. On conflict, return cas_failed.
   * Caller may merge and retry.
   *
   * Card identity is the id; title slug may change. We CAS against the existing
   * object for that id (if any), then write the new key and delete the old key
   * when the filename changes.
   */
  async writeCard(
    boardId: string,
    card: Card,
    options?: { message?: string; expectedEtag?: string },
  ): Promise<StorageResult<{ etag?: string }>> {
    const filename = cardFilename(card.frontmatter.id, card.frontmatter.title);
    const key = this.cardKey(boardId, filename);
    const body = serializeCard(card);

    // Locate existing object for this card id (may differ by slug)
    const listed = await this.listCards(boardId);
    const existing = listed.ok
      ? listed.value.find((c) => c.id === card.frontmatter.id)
      : undefined;
    let existingEtag: string | undefined;
    let existingKey: string | undefined;
    if (existing) {
      existingKey = existing.path;
      const cur = await this.client.get(existing.path);
      if (cur) existingEtag = cur.etag;
    }

    // Create path: no prior object
    if (!existingKey) {
      if (options?.expectedEtag !== undefined) {
        return {
          ok: false,
          error: {
            kind: "cas_failed",
            message: "S3 conditional put failed — object does not exist",
            etag: undefined,
          },
        };
      }
      const r = await this.client.put(key, body);
      if ("conflict" in r) {
        return {
          ok: false,
          error: {
            kind: "cas_failed",
            message: "S3 conditional put failed (412 equivalent)",
            etag: r.etag,
          },
        };
      }
      return { ok: true, value: { etag: r.etag } };
    }

    // Update path: require matching etag (explicit or discovered)
    const required = options?.expectedEtag ?? existingEtag;
    if (options?.expectedEtag !== undefined && options.expectedEtag !== existingEtag) {
      return {
        ok: false,
        error: {
          kind: "cas_failed",
          message: "S3 conditional put failed (412 equivalent)",
          etag: existingEtag,
        },
      };
    }

    // Same key: conditional put in place
    if (existingKey === key) {
      const r = await this.client.put(key, body, { ifMatch: required });
      if ("conflict" in r) {
        return {
          ok: false,
          error: {
            kind: "cas_failed",
            message: "S3 conditional put failed (412 equivalent)",
            etag: r.etag,
          },
        };
      }
      return { ok: true, value: { etag: r.etag } };
    }

    // Filename changed: CAS-delete semantics — put new key, remove old
    // Re-check etag still matches before swapping
    if (required !== existingEtag) {
      return {
        ok: false,
        error: {
          kind: "cas_failed",
          message: "S3 conditional put failed (412 equivalent)",
          etag: existingEtag,
        },
      };
    }
    const r = await this.client.put(key, body);
    if ("conflict" in r) {
      return {
        ok: false,
        error: {
          kind: "cas_failed",
          message: "S3 conditional put failed (412 equivalent)",
          etag: r.etag,
        },
      };
    }
    if (this.client.delete) {
      await this.client.delete(existingKey);
    }
    return { ok: true, value: { etag: r.etag } };
  }

  async moveCard(
    boardId: string,
    cardId: string,
    toColumn: string,
    newOrder: string,
    options?: { actor?: string },
  ): Promise<StorageResult<{ etag?: string }>> {
    const read = await this.readCard(boardId, cardId);
    if (!read.ok) return read;
    const card = read.value;
    const etag = (card as Card & { etag?: string }).etag;
    const from = card.frontmatter.column;
    card.frontmatter.column = toColumn;
    card.frontmatter.order = newOrder;
    card.frontmatter.updated = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    const today = new Date().toISOString().slice(0, 10);
    card.log.push(`${today} ${options?.actor ?? "human"}: moved ${from} → ${toColumn}`);
    return this.writeCard(boardId, card, { expectedEtag: etag });
  }
}
