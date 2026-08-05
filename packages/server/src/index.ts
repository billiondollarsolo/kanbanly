/**
 * @kanbanly/server — OSS HTTP server + in-memory board index.
 */
export {
  BoardIndexStore,
  type IndexedCard,
  type IndexedBoard,
  type QuarantineItem,
  type RemoteIndex,
  type RebuildResult,
} from "./index-store.ts";

export {
  connectLocalRepo,
  connectRemoteRepo,
  ensureBoardScaffold,
  refreshRepo,
  globalIndexStore,
  defaultCloneRoot,
  type ConnectedRepo,
  type ConnectOptions,
} from "./connect.ts";

export {
  RemoteRegistry,
  slugifyRemoteKey,
  type RemoteEntry,
  type RemoteSummary,
} from "./remote-registry.ts";

export {
  createHandler,
  startServer,
  type AppOptions,
  type ServeOptions,
  type StartedServer,
} from "./app.ts";

export {
  LiveHub,
  formatSse,
  type LiveEvent,
  type LiveHubOptions,
} from "./live.ts";

export {
  PushQueue,
  defaultQueuePath,
  labelFor,
  syncTooltip,
  type SyncState,
  type SyncStatus,
  type PushQueueOptions,
} from "./push-queue.ts";

export {
  CredentialStore,
  defaultCredentialPath,
  type GitCredential,
} from "@kanbanly/core";

export {
  main as cliMain,
  parseArgs,
  warnIfPublicBind,
  isLoopbackHost,
  DEFAULT_HOST,
  DEFAULT_PORT,
  LOOPBACK_HOSTS,
} from "./cli.ts";
