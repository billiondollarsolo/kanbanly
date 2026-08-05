/**
 * Multi-remote registry: several connected boards repos at once.
 * Active remote drives default /api/boards routes; all are addressable
 * via slug in /api/remotes and hash deep links #/r/<slug>/b/<board>.
 */

import { basename } from "node:path";
import type { ConnectedRepo } from "./connect.ts";

export type RemoteSummary = {
  slug: string;
  label: string;
  path: string;
  remoteUrl: string | null;
  sha: string;
  boards: Array<{ id: string; cardCount: number }>;
  cardCount: number;
  active: boolean;
};

export type RemoteEntry = {
  slug: string;
  label: string;
  connected: ConnectedRepo;
};

export function slugifyRemoteKey(pathOrUrl: string): string {
  const base = pathOrUrl
    .replace(/\.git$/, "")
    .replace(/\/+$/, "")
    .split(/[/\\]/)
    .filter(Boolean)
    .pop() ?? "boards";
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "boards";
}

export class RemoteRegistry {
  private bySlug = new Map<string, RemoteEntry>();
  private activeSlug: string | null = null;

  constructor(initial?: ConnectedRepo) {
    if (initial) this.add(initial);
  }

  list(): RemoteEntry[] {
    return [...this.bySlug.values()];
  }

  get(slug: string): RemoteEntry | undefined {
    return this.bySlug.get(slug);
  }

  active(): RemoteEntry | undefined {
    if (!this.activeSlug) return undefined;
    return this.bySlug.get(this.activeSlug);
  }

  activeConnected(): ConnectedRepo | undefined {
    return this.active()?.connected;
  }

  setActive(slug: string): boolean {
    if (!this.bySlug.has(slug)) return false;
    this.activeSlug = slug;
    return true;
  }

  /**
   * Register (or replace) a connected repo. Sets it active.
   * Slug derived from path basename / remote URL; collisions get -2, -3, …
   */
  add(connected: ConnectedRepo, preferredSlug?: string): RemoteEntry {
    // Reuse existing slug if same path already registered
    for (const e of this.bySlug.values()) {
      if (e.connected.path === connected.path) {
        e.connected = connected;
        this.activeSlug = e.slug;
        return e;
      }
    }

    let base =
      preferredSlug?.trim() ||
      slugifyRemoteKey(connected.remoteUrl ?? connected.path);
    // Prefer last path segment
    if (!preferredSlug) {
      base = slugifyRemoteKey(basename(connected.path) || connected.path);
    }
    let slug = base;
    let n = 2;
    while (this.bySlug.has(slug)) {
      slug = `${base}-${n}`;
      n += 1;
    }

    const entry: RemoteEntry = {
      slug,
      label: connected.remoteUrl
        ? connected.remoteUrl.replace(/\.git$/, "").split("/").slice(-2).join("/")
        : basename(connected.path),
      connected,
    };
    this.bySlug.set(slug, entry);
    this.activeSlug = slug;
    return entry;
  }

  remove(slug: string): boolean {
    if (!this.bySlug.delete(slug)) return false;
    if (this.activeSlug === slug) {
      const next = this.bySlug.keys().next();
      this.activeSlug = next.done ? null : next.value!;
    }
    return true;
  }

  summaries(): RemoteSummary[] {
    return this.list().map((e) => ({
      slug: e.slug,
      label: e.label,
      path: e.connected.path,
      remoteUrl: e.connected.remoteUrl ?? null,
      sha: e.connected.index.sha,
      boards: e.connected.index.boards.map((b) => ({
        id: b.id,
        cardCount: b.cards.length,
      })),
      cardCount: e.connected.index.cards.length,
      active: e.slug === this.activeSlug,
    }));
  }
}
