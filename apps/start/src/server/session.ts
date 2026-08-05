/**
 * Server-only singleton: one connected boards repo per process.
 * Configure with KANBANLY_REPO (absolute or relative path).
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  BoardIndexStore,
  LiveHub,
  PushQueue,
  connectLocalRepo,
  defaultQueuePath,
  refreshRepo,
  type ConnectedRepo,
} from "@kanbanly/server";

export type BoardSession = {
  connected: ConnectedRepo;
  indexStore: BoardIndexStore;
  live: LiveHub;
  pushQueue: PushQueue;
};

let session: BoardSession | null = null;
let sessionPath: string | null = null;

export function resolveRepoPath(): string {
  const env = process.env.KANBANLY_REPO;
  if (env && env.length > 0) return resolve(env);
  // Default: monorepo fixture
  const fixture = resolve(process.cwd(), "fixtures/boards-layout-a");
  if (existsSync(fixture)) return fixture;
  const fromApps = resolve(process.cwd(), "../../fixtures/boards-layout-a");
  if (existsSync(fromApps)) return fromApps;
  throw new Error(
    "KANBANLY_REPO not set and fixtures/boards-layout-a not found. Set KANBANLY_REPO to a boards git repo.",
  );
}

export async function getSession(): Promise<BoardSession> {
  const path = resolveRepoPath();
  if (session && sessionPath === path) return session;

  if (session) {
    session.live.stop();
    session.pushQueue.stop();
  }

  const indexStore = new BoardIndexStore();
  const connected = await connectLocalRepo(path, { indexStore });
  const live = new LiveHub({
    connected,
    indexStore,
    intervalMs: Number(process.env.KANBANLY_POLL_MS ?? 15_000),
    fetchRemote: process.env.KANBANLY_FETCH_REMOTE !== "0",
  });
  live.start();

  const pushQueue = new PushQueue({
    storage: connected.storage,
    queuePath: defaultQueuePath(connected.path),
    debounceMs: Number(process.env.KANBANLY_PUSH_DEBOUNCE_MS ?? 2000),
  });

  session = { connected, indexStore, live, pushQueue };
  sessionPath = path;
  return session;
}

export async function afterWrite(
  s: BoardSession,
  sha?: string,
): Promise<void> {
  await refreshRepo(s.connected, { indexStore: s.indexStore, force: true });
  if (sha) {
    s.live.notifyWrite(sha);
    s.pushQueue.enqueue(sha);
  }
}
