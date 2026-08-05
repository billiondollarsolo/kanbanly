/**
 * TanStack Query bindings for the board API.
 *
 * One module owns every cache key and every read/write hook, so the app has a
 * single vocabulary for data: components ask for a query by name, mutations
 * invalidate by name, and the live (SSE) channel invalidates exactly the names
 * the server just moved. `api.ts` stays a plain fetch layer with no React in it.
 *
 * Two rules this file exists to enforce:
 *   1. A read is owned by its cache entry, not by the component that happens to
 *      be mounted. Nothing here cancels an in-flight request on re-render.
 *   2. A write says what it invalidates. There is no god-refetch.
 */
import { useMemo } from "react";
import {
  keepPreviousData,
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
  QueryClient,
} from "@tanstack/react-query";
import * as api from "./api.ts";

const ROOT = "kanbanly";

/**
 * Cache keys. Every key is nested under a single root so the live channel can
 * reason about "everything", and each family exposes a prefix (`…Root`) for
 * invalidating all of its instances at once.
 */
export const qk = {
  all: [ROOT] as const,
  boards: () => [ROOT, "boards"] as const,
  boardRoot: () => [ROOT, "board"] as const,
  board: (boardId: string) => [ROOT, "board", boardId] as const,
  portfolio: () => [ROOT, "portfolio"] as const,
  fleet: () => [ROOT, "fleet"] as const,
  sync: () => [ROOT, "sync"] as const,
  conflicts: () => [ROOT, "conflicts"] as const,
  remotes: () => [ROOT, "remotes"] as const,
  workspace: () => [ROOT, "workspace"] as const,
  credentialBook: () => [ROOT, "credential-book"] as const,
  connect: () => [ROOT, "connect"] as const,
  activityRoot: () => [ROOT, "activity"] as const,
  activity: (boardId: string, limit: number) =>
    [ROOT, "activity", boardId, limit] as const,
  prStatusesRoot: () => [ROOT, "pr-statuses"] as const,
  /** Keyed on the ref list itself, so a fresh `cards` array is not a new key. */
  prStatuses: (refs: readonly string[]) =>
    [ROOT, "pr-statuses", refs.join(",")] as const,
  cardHistoryRoot: () => [ROOT, "card-history"] as const,
  cardHistory: (boardId: string, cardId: string) =>
    [ROOT, "card-history", boardId, cardId] as const,
  codeHistoryRoot: () => [ROOT, "code-history"] as const,
  codeHistory: (boardId: string, limit: number) =>
    [ROOT, "code-history", boardId, limit] as const,
  boardNotesRoot: () => [ROOT, "board-notes"] as const,
  boardNotes: (boardId: string) => [ROOT, "board-notes", boardId] as const,
};

/** How often the sync pill re-reads the push queue. */
export const SYNC_POLL_MS = 1_500;
/** How often live PR checks are re-polled. */
export const PR_POLL_MS = 60_000;

/**
 * Client defaults tuned for a local-first board.
 *
 * The server is on localhost and emits a `board` SSE event on every write, so
 * freshness comes from invalidation, not from polling or refetch-on-focus.
 * `retry: false` keeps the error banners as immediate as the hand-rolled
 * fetches they replace — a retrying query would delay every failure by seconds.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 5_000,
        gcTime: 5 * 60_000,
        refetchOnWindowFocus: false,
        // Reconnecting is the one moment the whole cache is genuinely suspect.
        refetchOnReconnect: true,
        retry: false,
      },
      mutations: { retry: false },
    },
  });
}

// ---------------------------------------------------------------------------
// Query option factories. Shared by the hooks below and by the imperative
// `queryClient.fetchQuery` calls the route loader still needs, so a component
// and the loader can never disagree about how a thing is fetched.
// ---------------------------------------------------------------------------

export function boardsQuery() {
  return queryOptions({
    queryKey: qk.boards(),
    queryFn: () => api.listBoards(),
  });
}

export function boardQuery(boardId: string) {
  return queryOptions({
    queryKey: qk.board(boardId),
    queryFn: () => api.getBoard(boardId),
  });
}

export function portfolioQuery() {
  return queryOptions({
    queryKey: qk.portfolio(),
    queryFn: () => api.getPortfolio(),
  });
}

export function fleetHealthQuery() {
  return queryOptions({
    queryKey: qk.fleet(),
    queryFn: () => api.getFleetHealth(),
  });
}

export function remotesQuery() {
  return queryOptions({
    queryKey: qk.remotes(),
    queryFn: () => api.listRemotes(),
  });
}

/** Saved credentials, for pickers that let a board reuse one. */
export function credentialBookQuery() {
  return queryOptions({
    queryKey: qk.credentialBook(),
    queryFn: () => api.listCredentialBook(),
  });
}

export function syncQuery() {
  return queryOptions({ queryKey: qk.sync(), queryFn: () => api.getSync() });
}

export function conflictsQuery() {
  return queryOptions({
    queryKey: qk.conflicts(),
    queryFn: () => api.listConflicts(),
  });
}

export function workspaceQuery() {
  return queryOptions({
    queryKey: qk.workspace(),
    queryFn: () => api.getWorkspace(),
  });
}

export function connectQuery() {
  return queryOptions({
    queryKey: qk.connect(),
    queryFn: () => api.getConnect(),
  });
}

export function activityQuery(boardId: string, limit: number) {
  return queryOptions({
    queryKey: qk.activity(boardId, limit),
    queryFn: () => api.getActivity(boardId, limit),
  });
}

export function prStatusesQuery(refs: readonly string[]) {
  return queryOptions({
    queryKey: qk.prStatuses(refs),
    queryFn: () => api.getPrStatuses([...refs]),
  });
}

export function cardHistoryQuery(boardId: string, cardId: string) {
  return queryOptions({
    queryKey: qk.cardHistory(boardId, cardId),
    queryFn: () => api.getCardHistory(boardId, cardId),
  });
}

export function codeHistoryQuery(boardId: string, limit: number) {
  return queryOptions({
    queryKey: qk.codeHistory(boardId, limit),
    queryFn: () => api.getCodeHistory(boardId, limit),
  });
}

export function boardNotesQuery(boardId: string) {
  return queryOptions({
    queryKey: qk.boardNotes(boardId),
    queryFn: () => api.getBoardNotes(boardId),
  });
}

// ---------------------------------------------------------------------------
// Read hooks
// ---------------------------------------------------------------------------

export function useBoards() {
  return useQuery(boardsQuery());
}

/**
 * The open board.
 *
 * `keepPreviousData` reproduces the old imperative order — the previous grid
 * stayed on screen until `getBoard` resolved, because `setBoard` ran after the
 * await — rather than blanking the board on every switch.
 */
export function useBoard(boardId: string | null) {
  return useQuery({
    ...boardQuery(boardId ?? ""),
    enabled: Boolean(boardId),
    placeholderData: keepPreviousData,
  });
}

export function usePortfolio(enabled: boolean) {
  return useQuery({ ...portfolioQuery(), enabled });
}

export function useFleetHealth(enabled: boolean) {
  return useQuery({ ...fleetHealthQuery(), enabled });
}

export function useRemotes() {
  return useQuery(remotesQuery());
}

/**
 * Push-queue state behind the header pill.
 *
 * `refetchIntervalInBackground` has to be on. The default pauses the interval
 * whenever the window loses focus, and the normal way to use this app is to
 * leave the board open in a background tab while you work — the pill freezing
 * there would be a real regression against the bare `setInterval` this
 * replaces. The re-render storm that motivated pausing is handled instead by
 * structural sharing: an unchanged payload keeps its object identity, so the
 * tick costs a request and nothing else.
 */
export function useSync() {
  return useQuery({
    ...syncQuery(),
    refetchInterval: SYNC_POLL_MS,
    refetchIntervalInBackground: true,
  });
}

export function useConflicts(enabled: boolean) {
  return useQuery({ ...conflictsQuery(), enabled });
}

export function useWorkspace(enabled: boolean) {
  return useQuery({ ...workspaceQuery(), enabled });
}

export function useConnectStatus(enabled: boolean) {
  return useQuery({ ...connectQuery(), enabled });
}

export function useActivity(
  boardId: string | null,
  limit: number,
  enabled: boolean,
) {
  return useQuery({
    ...activityQuery(boardId ?? "", limit),
    enabled: enabled && Boolean(boardId),
  });
}

/**
 * Live PR checks for the cards that carry a `pr:` ref.
 *
 * Keyed on the joined refs rather than the `cards` array, so a board refetch
 * that produces an identical ref list neither restarts the 60s interval nor
 * fires an extra request.
 */
export function usePrStatuses(refs: readonly string[]) {
  return useQuery({
    ...prStatusesQuery(refs),
    enabled: refs.length > 0,
    refetchInterval: PR_POLL_MS,
    // Same reasoning as the sync pill: the interval it replaces did not care
    // about focus, and a board left open should keep its PR checks current.
    refetchIntervalInBackground: true,
  });
}

export function useCardHistory(boardId: string, cardId: string) {
  return useQuery({
    ...cardHistoryQuery(boardId, cardId),
    enabled: Boolean(boardId && cardId),
  });
}

/**
 * Project/code-repo commits for a board (not the boards-repo log).
 *
 * This read used to be a hand-rolled effect whose own state marker sat in its
 * dependency array: setting the marker re-ran the effect, and the cleanup
 * cancelled the request it had just started. A query cannot regress that way —
 * the request belongs to the cache entry (keyed on board + limit), not to the
 * component, so a re-render, `enabled` flipping back to false, or the card
 * modal unmounting never aborts an in-flight fetch. The response still lands.
 *
 * Failures stay local on purpose. An unbound or unreadable source repo means
 * "no commit list", not a board-level error, so callers read
 * `data?.commits ?? []` and render nothing at all.
 */
export function useCodeHistory(
  boardId: string | null,
  limit: number,
  enabled: boolean,
) {
  return useQuery({
    ...codeHistoryQuery(boardId ?? "", limit),
    enabled: enabled && Boolean(boardId),
  });
}

export function useBoardNotes(boardId: string | null, enabled: boolean) {
  return useQuery({
    ...boardNotesQuery(boardId ?? ""),
    enabled: enabled && Boolean(boardId),
    // The notes editor seeds a draft from this, so every open re-reads the file
    // rather than handing the user a cached body someone else may have changed.
    staleTime: 0,
    refetchOnMount: "always",
  });
}

// ---------------------------------------------------------------------------
// Invalidation
// ---------------------------------------------------------------------------

export type Invalidators = {
  boards(): Promise<void>;
  board(boardId?: string | null): Promise<void>;
  portfolio(): Promise<void>;
  fleet(): Promise<void>;
  workspace(): Promise<void>;
  sync(): Promise<void>;
  conflicts(): Promise<void>;
  remotes(): Promise<void>;
  activity(): Promise<void>;
  codeHistory(boardId?: string | null): Promise<void>;
  /** Everything a card or column write can move. */
  boardWrite(boardId?: string | null): Promise<void>;
  /** The server pushed a new sha: every board-derived read is suspect. */
  live(): Promise<void>;
};

export function makeInvalidators(qc: QueryClient): Invalidators {
  const drop = (p: Promise<unknown>) => p.then(() => undefined);
  const inval = (queryKey: readonly unknown[]) =>
    drop(qc.invalidateQueries({ queryKey }));
  const boardKey = (boardId?: string | null) =>
    boardId ? qk.board(boardId) : qk.boardRoot();
  const codeKey = (boardId?: string | null) =>
    boardId
      ? ([...qk.codeHistoryRoot(), boardId] as const)
      : qk.codeHistoryRoot();

  return {
    boards: () => inval(qk.boards()),
    board: (boardId) => inval(boardKey(boardId)),
    portfolio: () => inval(qk.portfolio()),
    fleet: () => inval(qk.fleet()),
    workspace: () => inval(qk.workspace()),
    sync: () => inval(qk.sync()),
    conflicts: () => inval(qk.conflicts()),
    remotes: () => inval(qk.remotes()),
    activity: () => inval(qk.activityRoot()),
    codeHistory: (boardId) => inval(codeKey(boardId)),
    boardWrite: (boardId) =>
      drop(
        Promise.all([
          inval(boardKey(boardId)),
          inval(qk.boards()),
          inval(qk.portfolio()),
          inval(qk.fleet()),
          inval(qk.activityRoot()),
          inval(qk.sync()),
        ]),
      ),
    // Deliberately excludes code-history (a boards-repo sha says nothing about
    // the source repo) and board notes (refetching either would fight an open
    // modal that holds an unsaved draft).
    live: () =>
      drop(
        Promise.all([
          inval(qk.boards()),
          inval(qk.boardRoot()),
          inval(qk.portfolio()),
          inval(qk.fleet()),
          inval(qk.activityRoot()),
          inval(qk.sync()),
          inval(qk.remotes()),
          inval(qk.workspace()),
        ]),
      ),
  };
}

/** Memoised on the client, so it is safe to name as an effect dependency. */
export function useInvalidators(): Invalidators {
  const qc = useQueryClient();
  return useMemo(() => makeInvalidators(qc), [qc]);
}

/** Fold a mutation's piggy-backed sync state into the cache. */
export function applySync(
  qc: QueryClient,
  sync: api.SyncState | null | undefined,
): void {
  if (sync) qc.setQueryData(qk.sync(), sync);
}

// ---------------------------------------------------------------------------
// Write hooks. Each one states its own invalidation; returning the invalidation
// promise from `onSuccess` keeps the mutation `pending` until the refetch lands,
// which is what the old `await reload()` inside the try block did.
// ---------------------------------------------------------------------------

/** Card moved between/within columns. */
export function useMoveCard() {
  const qc = useQueryClient();
  const inv = makeInvalidators(qc);
  return useMutation({
    mutationFn: (v: {
      boardId: string;
      cardId: string;
      payload: { column: string; order: string };
    }) => api.moveCard(v.boardId, v.cardId, v.payload),
    onSuccess: (res, v) => {
      applySync(qc, res.sync);
      return inv.boardWrite(v.boardId);
    },
    // A failed move leaves an optimistic card in the wrong lane; refetching is
    // the only way back to the truth on disk.
    onError: (_e, v) => inv.boardWrite(v.boardId),
  });
}

export function useCreateCard() {
  const qc = useQueryClient();
  const inv = makeInvalidators(qc);
  return useMutation({
    mutationFn: (v: { boardId: string; title: string; column: string }) =>
      api.createCard(v.boardId, v.title, v.column),
    onSuccess: (res, v) => {
      applySync(qc, res.sync);
      return inv.boardWrite(v.boardId);
    },
    onError: (_e, v) => inv.boardWrite(v.boardId),
  });
}

export function useAddColumn() {
  const qc = useQueryClient();
  const inv = makeInvalidators(qc);
  return useMutation({
    mutationFn: (v: { boardId: string; name: string }) =>
      api.addColumn(v.boardId, v.name),
    onSuccess: (res, v) => {
      applySync(qc, res.sync);
      return inv.boardWrite(v.boardId);
    },
  });
}

export function useRenameColumn() {
  const qc = useQueryClient();
  const inv = makeInvalidators(qc);
  return useMutation({
    mutationFn: (v: { boardId: string; columnId: string; name: string }) =>
      api.renameColumn(v.boardId, v.columnId, v.name),
    onSuccess: (res, v) => {
      applySync(qc, res.sync);
      return inv.boardWrite(v.boardId);
    },
  });
}

export function useReorderColumns() {
  const qc = useQueryClient();
  const inv = makeInvalidators(qc);
  return useMutation({
    mutationFn: (v: { boardId: string; order: string[] }) =>
      api.reorderColumns(v.boardId, v.order),
    onSuccess: (res, v) => {
      applySync(qc, res.sync);
      // The server echoes the authoritative column list, so the optimistic
      // order is already reconciled by the caller; only the derived surfaces
      // (board list, portfolio) need a round trip.
      if (res.columns?.length) return inv.boards();
      return inv.boardWrite(v.boardId);
    },
    onError: (_e, v) => inv.boardWrite(v.boardId),
  });
}

export function useDeleteColumn() {
  const qc = useQueryClient();
  const inv = makeInvalidators(qc);
  return useMutation({
    mutationFn: (v: { boardId: string; columnId: string; moveTo?: string }) =>
      api.deleteColumn(v.boardId, v.columnId, v.moveTo),
    onSuccess: (res, v) => {
      applySync(qc, res.sync);
      return inv.boardWrite(v.boardId);
    },
  });
}

export function useUpdateCard() {
  const qc = useQueryClient();
  const inv = makeInvalidators(qc);
  return useMutation({
    mutationFn: (v: {
      boardId: string;
      cardId: string;
      patch: api.CardUpdate;
    }) => api.updateCard(v.boardId, v.cardId, v.patch),
    onSuccess: (res, v) => {
      applySync(qc, res.sync);
      return inv.boardWrite(v.boardId);
    },
  });
}

export function useArchiveCards() {
  const qc = useQueryClient();
  const inv = makeInvalidators(qc);
  return useMutation({
    mutationFn: (v: {
      boardId: string;
      body: { cardIds?: string[]; olderThanKeep?: number };
    }) => api.archiveCards(v.boardId, v.body),
    onSuccess: (res, v) => {
      applySync(qc, res.sync);
      return inv.boardWrite(v.boardId);
    },
  });
}

export function useRemapColumn() {
  const qc = useQueryClient();
  const inv = makeInvalidators(qc);
  return useMutation({
    mutationFn: (v: { boardId: string; from: string; to: string }) =>
      api.remapColumn(v.boardId, v.from, v.to),
    onSuccess: (_res, v) => inv.boardWrite(v.boardId),
  });
}

export function usePutBoardNotes() {
  const qc = useQueryClient();
  const inv = makeInvalidators(qc);
  return useMutation({
    mutationFn: (v: { boardId: string; body: string }) =>
      api.putBoardNotes(v.boardId, v.body),
    onSuccess: (_res, v) =>
      Promise.all([
        qc.invalidateQueries({ queryKey: qk.boardNotes(v.boardId) }),
        inv.sync(),
      ]).then(() => undefined),
  });
}

export function useRetrySync() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.retrySync(),
    onSuccess: (sync) => {
      qc.setQueryData(qk.sync(), sync);
    },
  });
}

export function useClearSyncFreeze() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.clearSyncFreeze(),
    onSuccess: (sync) => {
      qc.setQueryData(qk.sync(), sync);
    },
  });
}

export function usePullRemote() {
  const qc = useQueryClient();
  const inv = makeInvalidators(qc);
  return useMutation({
    mutationFn: () => api.pullRemote(),
    onSuccess: (res) => {
      applySync(qc, res.sync);
      // A fetch can fast-forward any board in the clone, so this is the one
      // write that legitimately invalidates every board.
      return inv.live();
    },
  });
}

export function useResolveConflict() {
  const qc = useQueryClient();
  const inv = makeInvalidators(qc);
  return useMutation({
    mutationFn: (v: {
      boardId: string;
      cardId: string;
      choice: "mine" | "theirs" | "heal";
    }) => api.resolveConflict(v.boardId, v.cardId, v.choice),
    onSuccess: (res, v) => {
      applySync(qc, res.sync);
      return Promise.all([inv.conflicts(), inv.boardWrite(v.boardId)]).then(
        () => undefined,
      );
    },
  });
}

export function useSetCredentials() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { token: string; username?: string }) => {
      await api.setCredentials(v);
      // The credential only matters once a push has been retried with it.
      return api.retrySync();
    },
    onSuccess: (sync) => {
      qc.setQueryData(qk.sync(), sync);
    },
  });
}

export function useConnectRepo() {
  const qc = useQueryClient();
  const inv = makeInvalidators(qc);
  return useMutation({
    mutationFn: (input: Parameters<typeof api.connectRepo>[0]) =>
      api.connectRepo(input),
    onSuccess: (res) => {
      if (res.remotes) {
        qc.setQueryData(qk.remotes(), {
          remotes: res.remotes,
          active: res.slug ?? null,
        });
      }
      return Promise.all([inv.live(), inv.workspace()]).then(() => undefined);
    },
  });
}

export function useCreateBoard() {
  const qc = useQueryClient();
  const inv = makeInvalidators(qc);
  return useMutation({
    mutationFn: (v: {
      name: string;
      options?: Parameters<typeof api.createBoard>[1];
    }) => api.createBoard(v.name, v.options),
    onSuccess: (res) => {
      applySync(qc, res.sync);
      return Promise.all([inv.boards(), inv.portfolio(), inv.workspace()]).then(
        () => undefined,
      );
    },
  });
}

export function usePatchBoardBinding() {
  const inv = makeInvalidators(useQueryClient());
  return useMutation({
    mutationFn: (input: Parameters<typeof api.patchBoardBinding>[0]) =>
      api.patchBoardBinding(input),
    onSuccess: () => inv.workspace(),
  });
}

export function usePatchConnection() {
  const inv = makeInvalidators(useQueryClient());
  return useMutation({
    mutationFn: (input: Parameters<typeof api.patchConnection>[0]) =>
      api.patchConnection(input),
    onSuccess: () => inv.workspace(),
  });
}

export function useUpsertCredentialBook() {
  const inv = makeInvalidators(useQueryClient());
  return useMutation({
    mutationFn: (input: Parameters<typeof api.upsertCredentialBook>[0]) =>
      api.upsertCredentialBook(input),
    onSuccess: () => inv.workspace(),
  });
}

export function useDeleteCredentialBook() {
  const inv = makeInvalidators(useQueryClient());
  return useMutation({
    mutationFn: (id: string) => api.deleteCredentialBook(id),
    onSuccess: () => inv.workspace(),
  });
}

export function useSetActiveRemote() {
  const qc = useQueryClient();
  const inv = makeInvalidators(qc);
  return useMutation({
    mutationFn: (slug: string) => api.setActiveRemote(slug),
    onSuccess: (res) => {
      qc.setQueryData(qk.remotes(), {
        remotes: res.remotes,
        active: res.active,
      });
      // Switching clone changes which boards exist at all.
      return inv.live();
    },
  });
}

/**
 * Bind a board to a source code repo.
 *
 * A remote URL means "clone/authenticate then bind" (`connectCodeSource`); a
 * bare path is just a binding patch. Both answers carry a fresh history, which
 * is written straight into the cache so the modal paints before the refetch.
 */
/** Manual "pull now" — invalidates everything the boards repo feeds. */
export function useRefreshRepo() {
  const qc = useQueryClient();
  const inv = makeInvalidators(qc);
  return useMutation({
    mutationFn: () => api.refreshRepo(),
    onSuccess: () => {
      // A refresh can change any board, so invalidate broadly rather than
      // guessing which slice moved.
      qc.invalidateQueries();
      inv.remotes();
    },
  });
}

export function useBindCodeSource() {
  const qc = useQueryClient();
  const inv = makeInvalidators(qc);
  return useMutation({
    mutationFn: (v: {
      boardId: string;
      path?: string;
      url?: string;
      token?: string;
      /** Saved credential to reuse for this binding. */
      credentialId?: string;
      /** Read commits via the GitHub API instead of cloning. */
      watch?: boolean;
      /** Cache slot the modal reads, so the echoed history lands where it shows. */
      limit: number;
    }) => {
      const body = {
        path: v.path,
        url: v.url,
        token: v.token,
        credentialId: v.credentialId,
        watch: v.watch,
      };
      return v.url
        ? api.connectCodeSource(v.boardId, body)
        : api.setCodeBinding(v.boardId, body);
    },
    onSuccess: (res, v) => {
      const history = res.history;
      const source = res.source;
      if (history) {
        qc.setQueryData<api.CodeHistoryResponse>(
          qk.codeHistory(v.boardId, v.limit),
          (prev) => ({
            boardId: v.boardId,
            source: "code",
            bound: history.bound,
            binding: source
              ? { path: source.path, remote: source.remote ?? undefined }
              : (prev?.binding ?? null),
            codePath: history.codePath,
            error: history.error,
            commits: history.commits,
            count: history.count,
          }),
        );
      }
      // Both limits are refreshed: binding a source changes what the card
      // modal's own (deeper) commit list should show too.
      return inv.codeHistory(v.boardId);
    },
  });
}

// ---------------------------------------------------------------------------
// Pure shaping helpers. Kept here (and tested) because they decide what a query
// result means to the UI.
// ---------------------------------------------------------------------------

/**
 * The distinct `pr:` refs on a board, sorted so an unchanged board always
 * produces byte-identical cache keys.
 */
export function prRefsFromCards(
  cards: ReadonlyArray<{ pr?: string }> | undefined,
): string[] {
  return [
    ...new Set((cards ?? []).map((c) => c.pr).filter((p): p is string => !!p)),
  ].sort();
}

/**
 * Join source-repo commits onto the card ids named in their subjects. Card ids
 * are matched lower-cased, which is how the detail panel looks them up.
 */
export function commitsByCardId(
  commits: ReadonlyArray<api.ProjectCommit> | undefined,
): Map<string, api.ProjectCommit[]> {
  const m = new Map<string, api.ProjectCommit[]>();
  for (const c of commits ?? []) {
    for (const id of c.cardIds ?? []) {
      const key = id.toLowerCase();
      const arr = m.get(key);
      if (arr) arr.push(c);
      else m.set(key, [c]);
    }
  }
  return m;
}
