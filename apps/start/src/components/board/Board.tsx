import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { draggable, dropTargetForElements } from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { combine } from "@atlaskit/pragmatic-drag-and-drop/combine";
import {
  attachClosestEdge,
  extractClosestEdge,
  type Edge,
} from "@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge";
import {
  applyOptimisticCreate,
  applyOptimisticMove,
  dropToMovePayload,
  filterCards,
  isInnermostDropTarget,
  keyToMoveDirection,
  keyToNavDirection,
  keyboardMoveTarget,
  navigateFocus,
  resolveDropIndex,
  staticPrStatus,
  type DropEdge,
  type NavBoard,
} from "@kanbanly/core";
import {
  archiveCards,
  clearSyncFreeze,
  createCard,
  getActivity,
  getBoard,
  getSync,
  listBoards,
  moveCard,
  remapColumn,
  retrySync,
  subscribeBoardEvents,
  updateCard,
  type ActivityEntry,
  type BoardCard,
  type BoardDetail,
  type BoardSummary,
  type SyncState,
} from "./api.ts";
import {
  applyTheme,
  readThemePreference,
  type ThemePreference,
} from "./theme.ts";

type CardDragData = {
  type: "card";
  cardId: string;
  boardId: string;
  columnId: string;
};

function isCardDrag(data: Record<string | symbol, unknown>): data is CardDragData {
  return data.type === "card" && typeof data.cardId === "string";
}

function toDropEdge(edge: Edge | null): DropEdge | null {
  if (edge === "top" || edge === "bottom" || edge === "left" || edge === "right") {
    return edge;
  }
  return null;
}

function CardView({
  card,
  boardId,
  columnId,
  onOpen,
  focused,
  onFocusCard,
}: {
  card: BoardCard;
  boardId: string;
  columnId: string;
  onOpen?: (card: BoardCard) => void;
  focused?: boolean;
  onFocusCard?: (cardId: string) => void;
}) {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (!el) return;
    return draggable({
      element: el,
      getInitialData: (): CardDragData => ({
        type: "card",
        cardId: card.id,
        boardId,
        columnId,
      }),
      onDragStart: () => setDragging(true),
      onDrop: () => setDragging(false),
    });
  }, [el, card.id, boardId, columnId]);

  useEffect(() => {
    if (focused && el) {
      el.focus({ preventScroll: false });
    }
  }, [focused, el]);

  return (
    <div
      ref={setEl}
      className={`kb-card${dragging ? " kb-card--dragging" : ""}${focused ? " kb-card--focused" : ""}`}
      data-card-id={card.id}
      data-column={columnId}
      data-testid={`card-${card.id}`}
      data-focused={focused ? "true" : undefined}
      onClick={() => {
        onFocusCard?.(card.id);
        onOpen?.(card);
      }}
      onFocus={() => onFocusCard?.(card.id)}
      role="button"
      tabIndex={focused ? 0 : -1}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen?.(card);
        }
      }}
    >
      <div className="kb-card-title">{card.title}</div>
      <div className="kb-card-meta">
        <span className="kb-card-id">{card.id}</span>
        {card.assignee ? <span className="kb-assignee">{card.assignee}</span> : null}
      </div>
      {card.pr ? <PrBadge pr={card.pr} /> : null}
      {card.labels && card.labels.length > 0 ? (
        <div className="kb-labels">
          {card.labels.map((l) => (
            <span key={l} className="kb-label">
              {l}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function PrBadge({ pr }: { pr: string }) {
  const status = staticPrStatus(pr);
  if (!status) return null;
  const label = status.ref.label;
  const hint =
    status.suggestedColumn != null
      ? ` ⇒ lands ${status.suggestedColumn.toUpperCase()}`
      : "";
  const inner = (
    <>
      PR {label}
      {status.state !== "unknown" ? ` · ${status.state}` : ""}
      {hint}
    </>
  );
  if (status.ref.url) {
    return (
      <a
        className="kb-pr"
        href={status.ref.url}
        target="_blank"
        rel="noreferrer"
        data-testid="pr-badge"
        onClick={(e) => e.stopPropagation()}
        title={status.ref.raw}
      >
        {inner}
      </a>
    );
  }
  return (
    <span className="kb-pr" data-testid="pr-badge" title={status.ref.raw}>
      {inner}
    </span>
  );
}

function ColumnView({
  boardId,
  columnId,
  columnName,
  cards,
  onDropCard,
  onOpenCard,
  onArchiveOlder,
  focusedCardId,
  onFocusCard,
}: {
  boardId: string;
  columnId: string;
  columnName: string;
  cards: BoardCard[];
  onDropCard: (
    cardId: string,
    toColumn: string,
    index: number,
  ) => Promise<void>;
  onOpenCard?: (card: BoardCard) => void;
  onArchiveOlder?: () => void;
  focusedCardId?: string | null;
  onFocusCard?: (cardId: string) => void;
}) {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [isOver, setIsOver] = useState(false);
  const [closestEdge, setClosestEdge] = useState<Edge | null>(null);
  const [overCardId, setOverCardId] = useState<string | null>(null);

  // Column drop target — only commits when it is the innermost target
  // (empty column / chrome). Nested card targets handle mid-list drops.
  useEffect(() => {
    if (!el) return;
    return dropTargetForElements({
      element: el,
      getData: () => ({ type: "column" as const, columnId, boardId }),
      canDrop: ({ source }) => isCardDrag(source.data),
      onDragEnter: () => setIsOver(true),
      onDragLeave: () => {
        setIsOver(false);
        setClosestEdge(null);
        setOverCardId(null);
      },
      onDrag: () => {
        setIsOver(true);
      },
      onDrop: async ({ source, self, location }) => {
        setIsOver(false);
        setClosestEdge(null);
        setOverCardId(null);
        // Pragmatic notifyCurrent fires all nested targets — only innermost commits
        if (!isInnermostDropTarget(self.element, location.current.dropTargets)) {
          return;
        }
        if (!isCardDrag(source.data)) return;
        const draggedId = source.data.cardId;
        const index = resolveDropIndex({
          draggedId,
          columnCards: cards,
          target: { type: "column" },
        });
        await onDropCard(draggedId, columnId, index);
      },
    });
  }, [el, boardId, columnId, cards, onDropCard]);

  // Card drop targets — edge from the card element (not the column)
  useEffect(() => {
    if (!el) return;
    const cleanups: Array<() => void> = [];
    for (const card of cards) {
      const node = el.querySelector(`[data-card-id="${card.id}"]`) as HTMLElement | null;
      if (!node) continue;
      cleanups.push(
        dropTargetForElements({
          element: node,
          getData: ({ input, element }) =>
            attachClosestEdge(
              { type: "card-slot" as const, cardId: card.id, columnId, boardId },
              { element, input, allowedEdges: ["top", "bottom"] },
            ),
          canDrop: ({ source }) => isCardDrag(source.data),
          onDragEnter: () => {
            setIsOver(true);
            setOverCardId(card.id);
          },
          onDrag: ({ self }) => {
            setClosestEdge(extractClosestEdge(self.data));
            setOverCardId(card.id);
          },
          onDragLeave: () => {
            setClosestEdge(null);
            setOverCardId(null);
          },
          onDrop: async ({ source, self, location }) => {
            setIsOver(false);
            setClosestEdge(null);
            setOverCardId(null);
            // Only innermost target commits (avoids double moveCard + wrong index)
            if (!isInnermostDropTarget(self.element, location.current.dropTargets)) {
              return;
            }
            if (!isCardDrag(source.data)) return;
            const draggedId = source.data.cardId;
            const edge = toDropEdge(extractClosestEdge(self.data));
            const index = resolveDropIndex({
              draggedId,
              columnCards: cards,
              target: { type: "card-slot", cardId: card.id, edge },
            });
            await onDropCard(draggedId, columnId, index);
          },
        }),
      );
    }
    return combine(...cleanups);
  }, [el, cards, boardId, columnId, onDropCard]);

  return (
    <section
      ref={setEl}
      className={`kb-column${isOver ? " kb-column--over" : ""}`}
      data-column-id={columnId}
      data-testid={`column-${columnId}`}
    >
      <header className="kb-column-header">
        <h3 className="kb-column-name">{columnName}</h3>
        <span className="kb-column-count" data-testid={`count-${columnId}`}>
          {cards.length}
        </span>
      </header>
      {columnId === "done" && cards.length > 20 && onArchiveOlder ? (
        <button
          type="button"
          className="kb-archive-btn"
          data-testid="archive-older"
          onClick={onArchiveOlder}
        >
          Archive {cards.length - 20} older cards
        </button>
      ) : null}
      <div className="kb-column-cards">
        {cards.length === 0 ? (
          <div className="kb-empty" data-testid={`empty-${columnId}`}>
            Empty
          </div>
        ) : (
          cards.map((card) => (
            <div key={card.id} className="kb-card-slot">
              {overCardId === card.id && closestEdge === "top" ? (
                <div className="kb-drop-indicator" data-testid="drop-indicator" />
              ) : null}
              <CardView
                card={card}
                boardId={boardId}
                columnId={columnId}
                onOpen={onOpenCard}
                focused={focusedCardId === card.id}
                onFocusCard={onFocusCard}
              />
              {overCardId === card.id && closestEdge === "bottom" ? (
                <div className="kb-drop-indicator" data-testid="drop-indicator" />
              ) : null}
            </div>
          ))
        )}
      </div>
    </section>
  );
}

function DetailPanel({
  card,
  onClose,
  onSave,
  busy,
}: {
  card: BoardCard;
  onClose: () => void;
  onSave: (patch: {
    title?: string;
    status?: string;
    assignee?: string | null;
    due?: string | null;
    labels?: string[];
  }) => Promise<void>;
  busy: boolean;
}) {
  const [title, setTitle] = useState(card.title);
  const [status, setStatusText] = useState(card.status ?? "");
  const [assignee, setAssignee] = useState(card.assignee ?? "");
  const [due, setDue] = useState(card.due ?? "");
  const [labels, setLabels] = useState((card.labels ?? []).join(", "));

  useEffect(() => {
    setTitle(card.title);
    setStatusText(card.status ?? "");
    setAssignee(card.assignee ?? "");
    setDue(card.due ?? "");
    setLabels((card.labels ?? []).join(", "));
  }, [card]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <aside className="kb-panel" data-testid="card-detail" data-card-id={card.id}>
      <div className="kb-panel-head">
        <strong data-testid="detail-id">{card.id}</strong>
        <button type="button" className="kb-panel-close" data-testid="detail-close" onClick={onClose}>
          Close
        </button>
      </div>
      <label className="kb-field">
        Title
        <input
          data-testid="detail-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </label>
      <label className="kb-field">
        Status
        <textarea
          data-testid="detail-status"
          rows={4}
          value={status}
          onChange={(e) => setStatusText(e.target.value)}
        />
      </label>
      <label className="kb-field">
        Assignee
        <input
          data-testid="detail-assignee"
          value={assignee}
          onChange={(e) => setAssignee(e.target.value)}
        />
      </label>
      <label className="kb-field">
        Due
        <input
          data-testid="detail-due"
          value={due}
          onChange={(e) => setDue(e.target.value)}
          placeholder="YYYY-MM-DD"
        />
      </label>
      <label className="kb-field">
        Labels (comma-separated)
        <input
          data-testid="detail-labels"
          value={labels}
          onChange={(e) => setLabels(e.target.value)}
        />
      </label>
      <button
        type="button"
        className="kb-panel-save"
        data-testid="detail-save"
        disabled={busy}
        onClick={() =>
          onSave({
            title,
            status,
            assignee: assignee.trim() || null,
            due: due.trim() || null,
            labels: labels
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean),
          })
        }
      >
        Save
      </button>
      <div className="kb-log" data-testid="detail-log">
        <h4>Log</h4>
        <ul>
          {(card.log ?? []).map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
      </div>
    </aside>
  );
}

export function BoardApp() {
  const [boards, setBoards] = useState<BoardSummary[]>([]);
  const [boardId, setBoardId] = useState<string | null>(null);
  const [board, setBoard] = useState<BoardDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string>("");
  const [sync, setSync] = useState<SyncState | null>(null);
  const [addTitle, setAddTitle] = useState("");
  const [addColumn, setAddColumn] = useState<string>("");
  const [selected, setSelected] = useState<BoardCard | null>(null);
  const [filterQuery, setFilterQuery] = useState("");
  const [filterLabel, setFilterLabel] = useState("");
  const [filterAssignee, setFilterAssignee] = useState("");
  const [themePref, setThemePref] = useState<ThemePreference>(() =>
    typeof document !== "undefined" ? readThemePreference() : "system",
  );
  const [showActivity, setShowActivity] = useState(false);
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [focusedCardId, setFocusedCardId] = useState<string | null>(null);
  const [browserOnline, setBrowserOnline] = useState(
    typeof navigator === "undefined" ? true : navigator.onLine,
  );

  const refreshSync = useCallback(async () => {
    try {
      setSync(await getSync());
    } catch {
      /* ignore */
    }
  }, []);

  const reload = useCallback(async (id?: string) => {
    setError(null);
    const list = await listBoards();
    setBoards(list.boards);
    const target = id ?? boardId ?? list.boards[0]?.id ?? null;
    setBoardId(target);
    if (target) {
      const detail = await getBoard(target);
      setBoard(detail);
      if (!addColumn && detail.columns[0]) {
        setAddColumn(detail.columns[0].id);
      }
    } else {
      setBoard(null);
    }
    await refreshSync();
  }, [boardId, addColumn, refreshSync]);

  useEffect(() => {
    applyTheme(themePref);
  }, [themePref]);

  useEffect(() => {
    reload().catch((e) => setError(String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!showActivity || !boardId) return;
    getActivity(boardId, 80)
      .then((r) => setActivity(r.entries))
      .catch((e) => setError(String(e)));
  }, [showActivity, boardId, board?.cards]);

  // Poll sync indicator (push queue) lightly
  useEffect(() => {
    const t = setInterval(() => {
      refreshSync().catch(() => undefined);
    }, 1500);
    return () => clearInterval(t);
  }, [refreshSync]);

  // Browser online/offline — auto-drain push queue on reconnect
  useEffect(() => {
    const on = () => {
      setBrowserOnline(true);
      retrySync()
        .then(setSync)
        .catch(() => undefined);
    };
    const off = () => setBrowserOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);

  // Live updates: SSE from server poll + local writes → reload board
  useEffect(() => {
    let lastSha = "";
    const unsub = subscribeBoardEvents((ev) => {
      if (ev.reason === "hello") {
        lastSha = ev.sha;
        return;
      }
      if (ev.sha && ev.sha !== lastSha) {
        lastSha = ev.sha;
        setStatus(ev.reason === "poll" ? "Updated from git…" : "Board updated");
        reload().catch((e) => setError(String(e)));
      }
    });
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onDropCard = useCallback(
    async (cardId: string, toColumn: string, index: number) => {
      if (!board || !boardId) return;
      const colCards =
        board.cardsByColumn[toColumn] ??
        board.cards.filter((c) => c.column === toColumn);
      const payload = dropToMovePayload(
        toColumn,
        colCards.map((c) => ({ id: c.id, order: c.order })),
        cardId,
        index,
      );

      // Optimistic: paint move at 0ms, then local commit via API
      setBoard(applyOptimisticMove(board, cardId, payload.column, payload.order));
      setStatus(`Moved ${cardId} → ${toColumn}`);
      setBusy(true);
      try {
        const res = await moveCard(boardId, cardId, payload);
        if (res && typeof res === "object" && "sync" in res && res.sync) {
          setSync(res.sync as SyncState);
        } else {
          await refreshSync();
        }
        // Reconcile with server
        await reload(boardId);
      } catch (e) {
        setError(String(e));
        setStatus("Move failed");
        await reload(boardId);
      } finally {
        setBusy(false);
      }
    },
    [board, boardId, reload, refreshSync],
  );

  const onCreate = useCallback(async () => {
    if (!boardId || !addTitle.trim() || !addColumn || !board) return;
    setBusy(true);
    const title = addTitle.trim();
    try {
      const res = await createCard(boardId, title, addColumn);
      setAddTitle("");
      // Optimistic paint if server returned the card
      if (res.card) {
        setBoard(
          applyOptimisticCreate(board, {
            id: res.card.id,
            title: res.card.title,
            column: res.card.column,
            order: res.card.order,
            status: "_Not started._",
            labels: [],
          }),
        );
      }
      setStatus("Card created");
      if (res && typeof res === "object" && "sync" in res && (res as { sync?: SyncState }).sync) {
        setSync((res as { sync: SyncState }).sync);
      }
      await reload(boardId);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [boardId, addTitle, addColumn, board, reload]);

  const columns = useMemo(() => board?.columns ?? [], [board]);

  const allLabels = useMemo(() => {
    if (!board) return [] as string[];
    const s = new Set<string>();
    for (const c of board.cards) for (const l of c.labels ?? []) s.add(l);
    return [...s].sort();
  }, [board]);

  const allAssignees = useMemo(() => {
    if (!board) return [] as string[];
    const s = new Set<string>();
    for (const c of board.cards) if (c.assignee) s.add(c.assignee);
    return [...s].sort();
  }, [board]);

  const filter = useMemo(
    () => ({
      query: filterQuery || undefined,
      label: filterLabel || undefined,
      assignee: filterAssignee || undefined,
    }),
    [filterQuery, filterLabel, filterAssignee],
  );

  /** Nav grid from current board (filtered cards per column). */
  const navBoard: NavBoard | null = useMemo(() => {
    if (!board) return null;
    const cardsByColumn: NavBoard["cardsByColumn"] = {};
    for (const col of board.columns) {
      const colCards = filterCards(
        (board.cardsByColumn[col.id] ?? []).slice().sort((a, b) => {
          if (a.order < b.order) return -1;
          if (a.order > b.order) return 1;
          return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
        }),
        filter,
      );
      cardsByColumn[col.id] = colCards.map((c) => ({
        id: c.id,
        column: c.column,
        order: c.order,
      }));
    }
    return { columns: board.columns, cardsByColumn };
  }, [board, filter]);

  const onBoardKeyDown = useCallback(
    (e: ReactKeyboardEvent) => {
      if (!board || !boardId || !navBoard) return;
      const target = e.target as HTMLElement;
      // Don't steal keys from inputs/selects/textarea
      if (
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.tagName === "SELECT" ||
        target.isContentEditable
      ) {
        return;
      }

      if (e.key === "Escape") {
        if (selected) {
          e.preventDefault();
          setSelected(null);
        }
        return;
      }

      const moveDir = keyToMoveDirection(e.key, e.shiftKey);
      if (moveDir && focusedCardId) {
        e.preventDefault();
        const dest = keyboardMoveTarget(navBoard, focusedCardId, moveDir);
        if (dest) {
          void onDropCard(focusedCardId, dest.columnId, dest.insertIndex);
        }
        return;
      }

      const navDir = keyToNavDirection(e.key);
      if (navDir) {
        e.preventDefault();
        const next = navigateFocus(navBoard, focusedCardId, navDir);
        if (next) setFocusedCardId(next);
        return;
      }

      if ((e.key === "Enter" || e.key === " ") && focusedCardId) {
        e.preventDefault();
        const card = board.cards.find((c) => c.id === focusedCardId);
        if (card) setSelected(card);
      }
    },
    [board, boardId, navBoard, focusedCardId, selected, onDropCard],
  );

  const onSaveDetail = useCallback(
    async (patch: {
      title?: string;
      status?: string;
      assignee?: string | null;
      due?: string | null;
      labels?: string[];
    }) => {
      if (!boardId || !selected) return;
      setBusy(true);
      try {
        const res = await updateCard(boardId, selected.id, patch);
        if (res.sync) setSync(res.sync);
        setStatus(`Updated ${selected.id}`);
        setSelected(res.card);
        await reload(boardId);
      } catch (e) {
        setError(String(e));
      } finally {
        setBusy(false);
      }
    },
    [boardId, selected, reload],
  );

  const onArchiveOlder = useCallback(async () => {
    if (!boardId) return;
    setBusy(true);
    try {
      const res = await archiveCards(boardId, { olderThanKeep: 20 });
      setStatus(`Archived ${res.archived.length} cards`);
      if (res.sync) setSync(res.sync);
      setSelected(null);
      await reload(boardId);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [boardId, reload]);

  const onRemapColumn = useCallback(
    async (from: string, to: string) => {
      if (!boardId) return;
      setBusy(true);
      try {
        const res = await remapColumn(boardId, from, to);
        setStatus(`Remapped ${res.remapped.length} cards ${from} → ${to}`);
        await reload(boardId);
      } catch (e) {
        setError(String(e));
      } finally {
        setBusy(false);
      }
    },
    [boardId, reload],
  );

  if (error && !board) {
    return (
      <div className="kb-app">
        <h1>kanbanly</h1>
        <p className="kb-error" data-testid="error">
          {error}
        </p>
        <p>Connect a boards repo with <code>--repo &lt;path&gt;</code>.</p>
      </div>
    );
  }

  return (
    <div
      className="kb-app"
      data-testid="board-app"
      onKeyDown={onBoardKeyDown}
      tabIndex={-1}
    >
      <header className="kb-top">
        <div>
          <h1>kanbanly</h1>
          <p className="kb-sub">
            Git-backed board · arrows/hjkl · Shift+←/→ move · Enter open
          </p>
        </div>
        <div className="kb-top-actions">
          {boards.length > 1 ? (
            <select
              value={boardId ?? ""}
              onChange={(e) => {
                setBoardId(e.target.value);
                reload(e.target.value).catch((err) => setError(String(err)));
              }}
              data-testid="board-select"
            >
              {boards.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.id} ({b.cardCount})
                </option>
              ))}
            </select>
          ) : (
            <span className="kb-board-label" data-testid="board-id">
              {boardId}
            </span>
          )}
          <span className="kb-status" data-testid="status">
            {busy ? "…" : status}
          </span>
          <span
            className={`kb-sync kb-sync--${sync?.status ?? "synced"}`}
            data-testid="sync-status"
            title={sync?.lastError ?? sync?.label ?? "synced"}
          >
            {sync?.label ?? "✓ synced"}
          </span>
          {sync?.status === "error" ? (
            <button
              type="button"
              className="kb-sync-retry"
              data-testid="sync-retry"
              onClick={() => {
                retrySync()
                  .then(setSync)
                  .catch((e) => setError(String(e)));
              }}
            >
              Retry
            </button>
          ) : null}
          <button
            type="button"
            className={`kb-activity-toggle${showActivity ? " is-on" : ""}`}
            data-testid="activity-toggle"
            onClick={() => setShowActivity((v) => !v)}
          >
            Activity
          </button>
          <select
            value={themePref}
            onChange={(e) => setThemePref(e.target.value as ThemePreference)}
            data-testid="theme-select"
            aria-label="Theme"
            className="kb-theme-select"
          >
            <option value="system">System</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </div>
      </header>

      {error ? (
        <p className="kb-error" data-testid="error">
          {error}
        </p>
      ) : null}

      {!browserOnline || sync?.status === "offline" || sync?.errorKind === "offline" ? (
        <div className="kb-banner kb-banner--offline" data-testid="banner-offline" role="status">
          <strong>
            {sync?.errorTitle ?? "Offline — remote unreachable"}
          </strong>
          <p>
            {sync?.errorDetail ??
              `Local commits keep working.${
                sync && sync.pendingCount > 0
                  ? ` ${sync.pendingCount} change(s) pending — will drain on reconnect.`
                  : ""
              }`}
          </p>
          <button
            type="button"
            data-testid="banner-offline-retry"
            onClick={() => retrySync().then(setSync).catch((e) => setError(String(e)))}
          >
            Retry push
          </button>
        </div>
      ) : null}

      {sync?.errorKind === "credential" ? (
        <div className="kb-banner kb-banner--credential" data-testid="banner-credential" role="alert">
          <strong>{sync.errorTitle ?? "Credential problem"}</strong>
          <p>{sync.errorDetail}</p>
          <p className="kb-banner-hint">
            Re-enter via SSH agent or mount a PAT, then retry. Exposed no-auth
            servers still bind loopback by default.
          </p>
          <button
            type="button"
            data-testid="banner-credential-retry"
            onClick={() => retrySync().then(setSync).catch((e) => setError(String(e)))}
          >
            Retry push
          </button>
        </div>
      ) : null}

      {sync?.frozen || sync?.errorKind === "conflict" || sync?.status === "frozen" ? (
        <div className="kb-banner kb-banner--conflict" data-testid="banner-conflict" role="alert">
          <strong>{sync?.errorTitle ?? "Conflict — sync frozen"}</strong>
          <p>{sync?.errorDetail}</p>
          <p className="kb-banner-hint">
            Resolve diverged cards (keep-mine / keep-theirs), then unfreeze and
            retry.
          </p>
          <button
            type="button"
            data-testid="banner-conflict-unfreeze"
            onClick={() =>
              clearSyncFreeze()
                .then(setSync)
                .catch((e) => setError(String(e)))
            }
          >
            Unfreeze sync
          </button>
          <button
            type="button"
            data-testid="banner-conflict-retry"
            onClick={() => retrySync().then(setSync).catch((e) => setError(String(e)))}
          >
            Retry push
          </button>
        </div>
      ) : null}

      {board ? (
        <>
          <div className="kb-filters" data-testid="filter-bar">
            <input
              type="search"
              placeholder="Filter text…"
              value={filterQuery}
              onChange={(e) => setFilterQuery(e.target.value)}
              data-testid="filter-query"
            />
            <select
              value={filterLabel}
              onChange={(e) => setFilterLabel(e.target.value)}
              data-testid="filter-label"
            >
              <option value="">All labels</option>
              {allLabels.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
            <select
              value={filterAssignee}
              onChange={(e) => setFilterAssignee(e.target.value)}
              data-testid="filter-assignee"
            >
              <option value="">All assignees</option>
              {allAssignees.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </div>

          <div className="kb-quick-add">
            <input
              type="text"
              placeholder="Add card title…"
              value={addTitle}
              onChange={(e) => setAddTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") onCreate();
              }}
              data-testid="add-title"
            />
            <select
              value={addColumn}
              onChange={(e) => setAddColumn(e.target.value)}
              data-testid="add-column"
            >
              {columns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <button type="button" onClick={onCreate} disabled={busy} data-testid="add-btn">
              Add card
            </button>
          </div>

          {(board.parseErrors && board.parseErrors.length > 0) ||
          (board.unknownColumns && board.unknownColumns.length > 0) ? (
            <div className="kb-quarantine" data-testid="quarantine">
              {board.parseErrors && board.parseErrors.length > 0 ? (
                <section
                  className="kb-quarantine-lane"
                  data-testid="quarantine-parse"
                >
                  <h3>
                    ⚠ Malformed cards ({board.parseErrors.length})
                  </h3>
                  <ul>
                    {board.parseErrors.map((q, i) => (
                      <li key={q.path ?? q.filename ?? i}>
                        <code>{q.filename ?? q.cardId ?? "unknown"}</code>
                        <span className="kb-quarantine-msg">{q.message}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
              {board.unknownColumns?.map((colId) => {
                const items = board.unknownByColumn?.[colId] ?? [];
                return (
                  <section
                    key={colId}
                    className="kb-quarantine-lane"
                    data-testid={`quarantine-col-${colId}`}
                  >
                    <h3>
                      ⚠ Unknown column: {colId} ({items.length})
                    </h3>
                    <ul>
                      {items.map((c) => (
                        <li key={c.id}>
                          <strong>{c.title}</strong>{" "}
                          <span className="kb-card-id">{c.id}</span>
                        </li>
                      ))}
                    </ul>
                    <label className="kb-remap">
                      Move all to
                      <select
                        data-testid={`remap-select-${colId}`}
                        defaultValue=""
                        onChange={(e) => {
                          const to = e.target.value;
                          if (to) void onRemapColumn(colId, to);
                        }}
                      >
                        <option value="" disabled>
                          choose column…
                        </option>
                        {columns.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  </section>
                );
              })}
            </div>
          ) : null}

          <div className="kb-main">
            <div className="kb-board" data-board-id={board.id} data-testid="board">
              {columns.map((col) => {
                const colCards = filterCards(
                  (board.cardsByColumn[col.id] ?? [])
                    .slice()
                    .sort((a, b) => {
                      if (a.order < b.order) return -1;
                      if (a.order > b.order) return 1;
                      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
                    }),
                  filter,
                );
                // Done column: show 20 most recent by updated when many
                const displayCards =
                  col.id === "done" && colCards.length > 20
                    ? colCards
                        .slice()
                        .sort((a, b) =>
                          (a.updated ?? "") < (b.updated ?? "")
                            ? 1
                            : (a.updated ?? "") > (b.updated ?? "")
                              ? -1
                              : 0,
                        )
                        .slice(0, 20)
                    : colCards;
                return (
                  <ColumnView
                    key={col.id}
                    boardId={board.id}
                    columnId={col.id}
                    columnName={col.name}
                    cards={displayCards}
                    onDropCard={onDropCard}
                    onOpenCard={(c) => {
                      setFocusedCardId(c.id);
                      setSelected(c);
                    }}
                    focusedCardId={focusedCardId}
                    onFocusCard={setFocusedCardId}
                    onArchiveOlder={
                      col.id === "done" && (board.cardsByColumn.done?.length ?? 0) > 20
                        ? onArchiveOlder
                        : undefined
                    }
                  />
                );
              })}
            </div>
            {selected ? (
              <DetailPanel
                card={
                  board.cards.find((c) => c.id === selected.id) ?? selected
                }
                onClose={() => setSelected(null)}
                onSave={onSaveDetail}
                busy={busy}
              />
            ) : null}
            {showActivity ? (
              <aside className="kb-activity" data-testid="activity-feed">
                <div className="kb-panel-head">
                  <strong>Activity</strong>
                  <button
                    type="button"
                    className="kb-panel-close"
                    onClick={() => setShowActivity(false)}
                  >
                    Close
                  </button>
                </div>
                {activity.length === 0 ? (
                  <p className="kb-empty">No log entries yet.</p>
                ) : (
                  <ul className="kb-activity-list">
                    {activity.map((e, i) => (
                      <li key={`${e.cardId}-${e.date}-${i}`} data-testid="activity-item">
                        <span className="kb-activity-date">{e.date}</span>
                        <button
                          type="button"
                          className="kb-activity-card"
                          onClick={() => {
                            const c = board.cards.find((x) => x.id === e.cardId);
                            if (c) setSelected(c);
                          }}
                        >
                          {e.cardId}
                        </button>
                        <span className="kb-activity-line">{e.line}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </aside>
            ) : null}
          </div>
        </>
      ) : (
        <p data-testid="empty-state">No boards connected.</p>
      )}
    </div>
  );
}
