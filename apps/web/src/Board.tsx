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
  applyAutoScroll,
  applyOptimisticCreate,
  applyOptimisticMove,
  computeAutoScrollDelta,
  dropToMovePayload,
  filterCards,
  formatBoardPath,
  formatBoardRoute,
  isFilterActive,
  isInnermostDropTarget,
  keyToMoveDirection,
  keyToNavDirection,
  keyboardMoveTarget,
  navigateFocus,
  parseBoardRoute,
  readWindowBoardRoute,
  renderMarkdown,
  resolveDropIndex,
  staticPrStatus,
  type DropEdge,
  type NavBoard,
} from "@kanbanly/core";
import {
  archiveCards,
  clearSyncFreeze,
  connectRepo,
  createCard,
  getActivity,
  getBoard,
  getCardHistory,
  getSync,
  listBoards,
  listConflicts,
  listRemotes,
  moveCard,
  pullRemote,
  remapColumn,
  resolveConflict,
  retrySync,
  setActiveRemote,
  setCredentials,
  getPrStatuses,
  subscribeBoardEvents,
  updateCard,
  type ActivityEntry,
  type BoardCard,
  type BoardDetail,
  type BoardSummary,
  type CardHistoryEntry,
  type ConflictItem,
  type PrStatusResponse,
  type RemoteSummary,
  type SyncState,
} from "./api.ts";
import {
  applyTheme,
  watchSystemTheme,
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
  prStatuses,
  selected,
  onToggleSelect,
}: {
  card: BoardCard;
  boardId: string;
  columnId: string;
  onOpen?: (card: BoardCard) => void;
  focused?: boolean;
  onFocusCard?: (cardId: string) => void;
  prStatuses?: Record<string, PrStatusResponse | null>;
  selected?: boolean;
  onToggleSelect?: (cardId: string, multi: boolean) => void;
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

  const ariaLabel = [
    card.title,
    `column ${columnId}`,
    card.assignee ? `assignee ${card.assignee}` : null,
    card.due ? `due ${card.due}` : null,
    card.priority ? `priority ${card.priority}` : null,
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <div
      ref={setEl}
      className={`kb-card${dragging ? " kb-card--dragging" : ""}${focused ? " kb-card--focused" : ""}${selected ? " kb-card--selected" : ""}`}
      data-card-id={card.id}
      data-column={columnId}
      data-testid={`card-${card.id}`}
      data-focused={focused ? "true" : undefined}
      data-selected={selected ? "true" : undefined}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey) {
          e.preventDefault();
          onToggleSelect?.(card.id, true);
          onFocusCard?.(card.id);
          return;
        }
        onFocusCard?.(card.id);
        onOpen?.(card);
      }}
      onFocus={() => onFocusCard?.(card.id)}
      role="button"
      tabIndex={focused ? 0 : -1}
      aria-label={ariaLabel}
      aria-grabbed={dragging ? true : undefined}
      aria-selected={selected ? true : undefined}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen?.(card);
        }
        if (e.key === "x" || e.key === "X") {
          e.preventDefault();
          onToggleSelect?.(card.id, true);
        }
      }}
    >
      {onToggleSelect ? (
        <label className="kb-card-check" onClick={(e) => e.stopPropagation()}>
          <input
            type="checkbox"
            checked={!!selected}
            data-testid={`select-${card.id}`}
            aria-label={`Select ${card.title}`}
            onChange={() => onToggleSelect(card.id, true)}
          />
        </label>
      ) : null}
      <div className="kb-card-title">{card.title}</div>
      <div className="kb-card-meta">
        <span className="kb-card-id">{card.id}</span>
        {card.assignee ? <span className="kb-assignee">{card.assignee}</span> : null}
        {card.due ? (
          <span className="kb-due" data-testid={`due-${card.id}`}>
            {card.due}
          </span>
        ) : null}
        {card.priority ? (
          <span className="kb-priority" data-testid={`priority-${card.id}`}>
            {card.priority}
          </span>
        ) : null}
      </div>
      {card.pr ? <PrBadge pr={card.pr} live={prStatuses?.[card.pr]} /> : null}
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

function PrBadge({
  pr,
  live,
}: {
  pr: string;
  live?: PrStatusResponse | null;
}) {
  const fallback = staticPrStatus(pr);
  if (!fallback && !live) return null;
  const status = live ?? {
    ref: fallback!.ref,
    state: fallback!.state,
    suggestedColumn: fallback!.suggestedColumn,
    source: fallback!.source,
    title: fallback!.title,
  };
  const label = status.ref.label;
  const hint =
    status.suggestedColumn != null
      ? ` ⇒ lands ${status.suggestedColumn.toUpperCase()}`
      : "";
  const merged = status.state === "merged";
  const inner = (
    <>
      PR {label}
      {status.state !== "unknown" ? ` · ${status.state}` : ""}
      {!merged && hint ? hint : ""}
      {merged ? " · cleared" : ""}
    </>
  );
  const cls = `kb-pr${status.source === "github" ? " kb-pr--live" : ""}${
    merged ? " kb-pr--merged" : ""
  }`;
  if (status.ref.url) {
    return (
      <a
        className={cls}
        href={status.ref.url}
        target="_blank"
        rel="noreferrer"
        data-testid="pr-badge"
        data-pr-state={status.state}
        data-pr-source={status.source}
        onClick={(e) => e.stopPropagation()}
        title={status.title ?? status.ref.raw}
      >
        {inner}
      </a>
    );
  }
  return (
    <span
      className={cls}
      data-testid="pr-badge"
      data-pr-state={status.state}
      data-pr-source={status.source}
      title={status.title ?? status.ref.raw}
    >
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
  onQuickAdd,
  focusedCardId,
  onFocusCard,
  prStatuses,
  selectedIds,
  onToggleSelect,
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
  onQuickAdd?: (columnId: string, title: string) => Promise<void>;
  focusedCardId?: string | null;
  onFocusCard?: (cardId: string) => void;
  prStatuses?: Record<string, PrStatusResponse | null>;
  selectedIds?: Set<string>;
  onToggleSelect?: (cardId: string, multi: boolean) => void;
}) {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [isOver, setIsOver] = useState(false);
  const [closestEdge, setClosestEdge] = useState<Edge | null>(null);
  const [overCardId, setOverCardId] = useState<string | null>(null);
  const [quickTitle, setQuickTitle] = useState("");
  const [adding, setAdding] = useState(false);

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

  // Auto-scroll when dragging near column card-list edges
  useEffect(() => {
    if (!el) return;
    const list = el.querySelector(".kb-cards") as HTMLElement | null;
    if (!list) return;
    let raf = 0;
    let last: { x: number; y: number } | null = null;
    const onMove = (e: DragEvent | PointerEvent) => {
      last = { x: e.clientX, y: e.clientY };
    };
    const tick = () => {
      if (last) {
        const rect = list.getBoundingClientRect();
        const delta = computeAutoScrollDelta({
          clientX: last.x,
          clientY: last.y,
          rect,
          threshold: 48,
          maxSpeed: 22,
        });
        applyAutoScroll(list, delta);
      }
      raf = requestAnimationFrame(tick);
    };
    const onDragStart = () => {
      raf = requestAnimationFrame(tick);
    };
    const onDragEnd = () => {
      cancelAnimationFrame(raf);
      last = null;
    };
    el.addEventListener("dragover", onMove as EventListener);
    window.addEventListener("drag", onMove as EventListener);
    window.addEventListener("dragstart", onDragStart);
    window.addEventListener("dragend", onDragEnd);
    window.addEventListener("drop", onDragEnd);
    return () => {
      cancelAnimationFrame(raf);
      el.removeEventListener("dragover", onMove as EventListener);
      window.removeEventListener("drag", onMove as EventListener);
      window.removeEventListener("dragstart", onDragStart);
      window.removeEventListener("dragend", onDragEnd);
      window.removeEventListener("drop", onDragEnd);
    };
  }, [el, cards.length]);

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
      role="region"
      aria-label={`${columnName} column, ${cards.length} card${cards.length === 1 ? "" : "s"}`}
    >
      <header className="kb-column-header">
        <h3 className="kb-column-name" id={`col-title-${columnId}`}>
          {columnName}
        </h3>
        <span
          className="kb-column-count"
          data-testid={`count-${columnId}`}
          aria-label={`${cards.length} cards`}
        >
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
      <div className="kb-column-cards kb-cards">
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
                prStatuses={prStatuses}
                selected={selectedIds?.has(card.id)}
                onToggleSelect={onToggleSelect}
              />
              {overCardId === card.id && closestEdge === "bottom" ? (
                <div className="kb-drop-indicator" data-testid="drop-indicator" />
              ) : null}
            </div>
          ))
        )}
      </div>
      {onQuickAdd ? (
        <div className="kb-col-add" data-testid={`col-add-${columnId}`}>
          <input
            type="text"
            placeholder="+ Add card"
            value={quickTitle}
            data-testid={`col-add-input-${columnId}`}
            disabled={adding}
            onChange={(e) => setQuickTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setQuickTitle("");
                (e.target as HTMLInputElement).blur();
              }
              if (e.key === "Enter" && quickTitle.trim()) {
                e.preventDefault();
                const t = quickTitle.trim();
                setAdding(true);
                setQuickTitle("");
                void onQuickAdd(columnId, t).finally(() => setAdding(false));
              }
            }}
          />
        </div>
      ) : null}
    </section>
  );
}

function DetailPanel({
  card,
  boardId,
  onClose,
  onSave,
  busy,
}: {
  card: BoardCard;
  boardId: string;
  onClose: () => void;
  onSave: (patch: {
    title?: string;
    status?: string;
    assignee?: string | null;
    due?: string | null;
    labels?: string[];
    priority?: string | null;
  }) => Promise<void>;
  busy: boolean;
}) {
  const [title, setTitle] = useState(card.title);
  const [status, setStatusText] = useState(card.status ?? "");
  const [assignee, setAssignee] = useState(card.assignee ?? "");
  const [due, setDue] = useState(card.due ?? "");
  const [priority, setPriority] = useState(card.priority ?? "");
  const [labels, setLabels] = useState((card.labels ?? []).join(", "));
  const [editStatus, setEditStatus] = useState(false);
  const [history, setHistory] = useState<CardHistoryEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);

  useEffect(() => {
    setTitle(card.title);
    setStatusText(card.status ?? "");
    setAssignee(card.assignee ?? "");
    setDue(card.due ?? "");
    setPriority(card.priority ?? "");
    setLabels((card.labels ?? []).join(", "));
    setEditStatus(false);
  }, [card]);

  useEffect(() => {
    let cancelled = false;
    setHistoryLoading(true);
    getCardHistory(boardId, card.id)
      .then((r) => {
        if (!cancelled) setHistory(r.entries);
      })
      .catch(() => {
        if (!cancelled) setHistory([]);
      })
      .finally(() => {
        if (!cancelled) setHistoryLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [boardId, card.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const statusHtml = useMemo(() => renderMarkdown(status), [status]);
  const logHtml = useMemo(
    () =>
      (card.log ?? [])
        .map((line) => `<li>${renderMarkdown(line)}</li>`)
        .join(""),
    [card.log],
  );

  return (
    <aside className="kb-panel" data-testid="card-detail" data-card-id={card.id}>
      <div className="kb-panel-head">
        <strong data-testid="detail-id">{card.id}</strong>
        <button
          type="button"
          className="kb-linkish"
          data-testid="detail-copy-link"
          onClick={() => {
            const path = formatBoardPath(boardId, card.id);
            const url =
              typeof window !== "undefined"
                ? `${window.location.origin}${path}`
                : path;
            void navigator.clipboard?.writeText(url).then(() => {
              setLinkCopied(true);
              setTimeout(() => setLinkCopied(false), 1500);
            });
          }}
        >
          {linkCopied ? "Copied!" : "Copy link"}
        </button>
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
      <div className="kb-field">
        <div className="kb-field-row">
          <span>Status</span>
          <button
            type="button"
            className="kb-linkish"
            data-testid="detail-status-toggle"
            onClick={() => setEditStatus((v) => !v)}
          >
            {editStatus ? "Preview" : "Edit"}
          </button>
        </div>
        {editStatus ? (
          <textarea
            data-testid="detail-status"
            rows={4}
            value={status}
            onChange={(e) => setStatusText(e.target.value)}
          />
        ) : (
          <div
            className="kb-md"
            data-testid="detail-status-md"
            dangerouslySetInnerHTML={{ __html: statusHtml || "<p><em>Empty</em></p>" }}
          />
        )}
      </div>
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
        Priority
        <input
          data-testid="detail-priority"
          value={priority}
          onChange={(e) => setPriority(e.target.value)}
          placeholder="P1"
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
      <div className="kb-field" data-testid="detail-log">
        <span>Log</span>
        <ul
          className="kb-md kb-log"
          dangerouslySetInnerHTML={{
            __html: logHtml || "<li><em>No log entries</em></li>",
          }}
        />
      </div>
      <div className="kb-field" data-testid="detail-history">
        <span>Git history</span>
        {historyLoading ? (
          <p className="kb-muted">Loading…</p>
        ) : history.length === 0 ? (
          <p className="kb-muted">No commits yet.</p>
        ) : (
          <ul className="kb-history-list">
            {history.map((h) => (
              <li key={h.sha} data-testid="history-entry">
                <code className="kb-history-sha">{h.sha.slice(0, 7)}</code>
                <span className="kb-history-subj">{h.subject}</span>
                <span className="kb-muted">
                  {h.author} · {h.date.slice(0, 10)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
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
            priority: priority.trim() || null,
            labels: labels
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean),
          })
        }
      >
        Save
      </button>
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
  const [conflicts, setConflicts] = useState<ConflictItem[]>([]);
  const [prStatuses, setPrStatuses] = useState<
    Record<string, PrStatusResponse | null>
  >({});
  const [credToken, setCredToken] = useState("");
  const [credUser, setCredUser] = useState("x-access-token");
  const [credBusy, setCredBusy] = useState(false);
  const [needsConnect, setNeedsConnect] = useState(false);
  const [connectUrl, setConnectUrl] = useState("");
  const [connectPath, setConnectPath] = useState("");
  const [connectToken, setConnectToken] = useState("");
  const [connectBusy, setConnectBusy] = useState(false);
  const [pendingCardId, setPendingCardId] = useState<string | null>(null);
  const [remotes, setRemotes] = useState<RemoteSummary[]>([]);
  const [remoteSlug, setRemoteSlug] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [showHelp, setShowHelp] = useState(false);

  const refreshSync = useCallback(async () => {
    try {
      setSync(await getSync());
    } catch {
      /* ignore */
    }
  }, []);

  const refreshConflicts = useCallback(async () => {
    try {
      const r = await listConflicts();
      setConflicts(r.conflicts);
    } catch {
      setConflicts([]);
    }
  }, []);

  const refreshRemotes = useCallback(async () => {
    try {
      const r = await listRemotes();
      setRemotes(r.remotes);
      if (r.active) setRemoteSlug(r.active);
    } catch {
      /* ignore when not connected */
    }
  }, []);

  const reload = useCallback(async (id?: string) => {
    setError(null);
    await refreshRemotes();
    const list = await listBoards();
    setBoards(list.boards);
    if (list.boards.length === 0) {
      setNeedsConnect(true);
      setBoard(null);
      setBoardId(null);
      await refreshSync();
      return;
    }
    setNeedsConnect(false);
    const route =
      typeof window !== "undefined"
        ? readWindowBoardRoute()
        : { boardId: null, cardId: null, remoteSlug: null };
    if (route.remoteSlug) setRemoteSlug(route.remoteSlug);
    const target =
      id ?? boardId ?? route.boardId ?? list.boards[0]?.id ?? null;
    setBoardId(target);
    if (target) {
      try {
        const detail = await getBoard(target);
        setBoard(detail);
        if (!addColumn && detail.columns[0]) {
          setAddColumn(detail.columns[0].id);
        }
        const wantCard = pendingCardId ?? route.cardId;
        if (wantCard) {
          const found = detail.cards.find((c) => c.id === wantCard);
          if (found) {
            setSelected(found);
            setFocusedCardId(found.id);
          } else if (route.cardId) {
            setError(`Card not found: ${route.cardId}`);
          }
          setPendingCardId(null);
        }
      } catch (e) {
        setBoard(null);
        setError(String(e));
      }
    } else {
      setBoard(null);
    }
    await refreshSync();
  }, [boardId, addColumn, refreshSync, pendingCardId, refreshRemotes]);

  useEffect(() => {
    applyTheme(themePref);
  }, [themePref]);

  // US-32: when preference is system, follow OS live changes
  useEffect(() => {
    return watchSystemTheme(() => themePref);
  }, [themePref]);

  useEffect(() => {
    // Seed from path or hash on first load
    if (typeof window !== "undefined") {
      const r = readWindowBoardRoute();
      if (r.boardId) setBoardId(r.boardId);
      if (r.cardId) setPendingCardId(r.cardId);
      if (r.remoteSlug) setRemoteSlug(r.remoteSlug);
    }
    reload().catch((e) => setError(String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep URL path in sync with remote + board + selected card (US-15)
  useEffect(() => {
    if (!boardId || typeof window === "undefined") return;
    const next = formatBoardPath(boardId, selected?.id ?? null, remoteSlug);
    const cur = window.location.pathname;
    if (cur !== next) {
      window.history.replaceState(null, "", next);
    }
  }, [boardId, selected?.id, remoteSlug]);

  // Browser back/forward (path + hash)
  useEffect(() => {
    const applyRoute = () => {
      const r = readWindowBoardRoute();
      const switchRemote = async () => {
        if (r.remoteSlug && r.remoteSlug !== remoteSlug) {
          await setActiveRemote(r.remoteSlug);
          setRemoteSlug(r.remoteSlug);
        }
      };
      void switchRemote()
        .then(() => {
          if (r.boardId && r.boardId !== boardId) {
            if (r.cardId) setPendingCardId(r.cardId);
            return reload(r.boardId);
          }
          if (r.cardId && board) {
            const found = board.cards.find((c) => c.id === r.cardId);
            if (found) {
              setSelected(found);
              setFocusedCardId(found.id);
            } else {
              setError(`Card not found: ${r.cardId}`);
            }
          } else if (!r.cardId) {
            setSelected(null);
          }
        })
        .catch((e) => setError(String(e)));
    };
    window.addEventListener("popstate", applyRoute);
    window.addEventListener("hashchange", applyRoute);
    return () => {
      window.removeEventListener("popstate", applyRoute);
      window.removeEventListener("hashchange", applyRoute);
    };
  }, [boardId, board, reload, remoteSlug]);
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

  // Browser online/offline — auto-drain push queue when back online
  useEffect(() => {
    const on = () => {
      setBrowserOnline(true);
      // Auto-drain pending remote pushes on reconnect
      retrySync()
        .then((s) => {
          setSync(s);
          if (s.pendingCount === 0 && s.status === "synced") {
            setStatus("Push queue drained after reconnect");
          }
        })
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

  // Load conflict list when frozen / conflict error
  useEffect(() => {
    if (sync?.frozen || sync?.errorKind === "conflict" || sync?.status === "frozen") {
      refreshConflicts().catch(() => undefined);
    }
  }, [sync?.frozen, sync?.errorKind, sync?.status, refreshConflicts]);

  // Live PR status poll for cards with pr: (not per-render network)
  useEffect(() => {
    const refs = [
      ...new Set(
        (board?.cards ?? [])
          .map((c) => c.pr)
          .filter((p): p is string => Boolean(p)),
      ),
    ];
    if (refs.length === 0) {
      setPrStatuses({});
      return;
    }
    let stopped = false;
    const tick = () => {
      getPrStatuses(refs)
        .then((m) => {
          if (!stopped) setPrStatuses(m);
        })
        .catch(() => undefined);
    };
    tick();
    const id = setInterval(tick, 60_000);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [board?.cards]);

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

  const createInColumn = useCallback(
    async (column: string, title: string) => {
      if (!boardId || !title.trim() || !board) return;
      setBusy(true);
      setError(null);
      try {
        setBoard(
          applyOptimisticCreate(board, {
            id: `tmp-${Date.now()}`,
            title: title.trim(),
            column,
            order: "z",
            status: "_Not started._",
            labels: [],
          }),
        );
        const res = await createCard(boardId, title.trim(), column);
        if (res && typeof res === "object" && "sync" in res && (res as { sync?: SyncState }).sync) {
          setSync((res as { sync: SyncState }).sync);
        }
        setStatus(`Created in ${column}`);
        await reload(boardId);
      } catch (e) {
        setError(String(e));
        await reload(boardId);
      } finally {
        setBusy(false);
      }
    },
    [boardId, board, reload],
  );

  const onCreate = useCallback(async () => {
    if (!addTitle.trim() || !addColumn) return;
    const title = addTitle.trim();
    setAddTitle("");
    await createInColumn(addColumn, title);
  }, [addTitle, addColumn, createInColumn]);

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

  const filtersActive = isFilterActive(filter);

  const clearFilters = useCallback(() => {
    setFilterQuery("");
    setFilterLabel("");
    setFilterAssignee("");
  }, []);

  const switchRemote = useCallback(
    async (slug: string, boardHint?: string) => {
      setBusy(true);
      try {
        const r = await setActiveRemote(slug);
        setRemotes(r.remotes);
        setRemoteSlug(r.active);
        setSelected(null);
        setBoardId(null);
        await reload(boardHint);
      } catch (e) {
        setError(String(e));
      } finally {
        setBusy(false);
      }
    },
    [reload],
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
        e.preventDefault();
        if (showHelp) {
          setShowHelp(false);
          return;
        }
        if (selected) {
          setSelected(null);
          return;
        }
        if (selectedIds.size > 0) {
          setSelectedIds(new Set());
          return;
        }
        return;
      }

      if (e.key === "?" || (e.shiftKey && e.key === "/")) {
        e.preventDefault();
        setShowHelp((v) => !v);
        return;
      }

      if ((e.key === "a" || e.key === "A") && (e.metaKey || e.ctrlKey) && selectedIds.size > 0) {
        // keep browser select-all out of the way when multi-selecting
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
    [board, boardId, navBoard, focusedCardId, selected, selectedIds, showHelp, onDropCard],
  );

  // Screen-reader polite announcement when focus moves between cards
  useEffect(() => {
    if (!focusedCardId || !board) return;
    const card = board.cards.find((c) => c.id === focusedCardId);
    if (!card) return;
    const el = document.getElementById("kb-sr-live");
    if (el) {
      el.textContent = `${card.title}, ${card.column}${card.assignee ? `, assigned ${card.assignee}` : ""}`;
    }
  }, [focusedCardId, board]);

  const onSaveDetail = useCallback(
    async (patch: {
      title?: string;
      status?: string;
      assignee?: string | null;
      due?: string | null;
      priority?: string | null;
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

  const toggleSelect = useCallback((cardId: string, _multi: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(cardId)) next.delete(cardId);
      else next.add(cardId);
      return next;
    });
  }, []);

  const bulkArchiveSelected = useCallback(async () => {
    if (!boardId || selectedIds.size === 0) return;
    setBusy(true);
    try {
      const ids = [...selectedIds];
      const res = await archiveCards(boardId, { cardIds: ids });
      if (res.sync) setSync(res.sync);
      setSelectedIds(new Set());
      setStatus(`Archived ${res.archived?.length ?? ids.length} card(s)`);
      await reload(boardId);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [boardId, selectedIds, reload]);

  const onPullRemote = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await pullRemote();
      if (r.sync) setSync(r.sync);
      setStatus(
        r.fastForwarded
          ? `Fetched remote · fast-forwarded${r.healed.length ? ` · healed ${r.healed.length}` : ""}`
          : `Fetched remote · up to date${r.healed.length ? ` · healed ${r.healed.length}` : ""}`,
      );
      await reload(boardId ?? undefined);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [boardId, reload]);

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
      <a href="#kb-main-board" className="kb-skip-link" data-testid="skip-link">
        Skip to board
      </a>
      <header className="kb-top">
        <div>
          <h1>kanbanly</h1>
          <p className="kb-sub">
            Git-backed board · arrows/hjkl · Shift+←/→ move · Enter open · ? help
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
          <button
            type="button"
            data-testid="pull-remote"
            onClick={() => void onPullRemote()}
            disabled={busy}
            title="Fetch + fast-forward from origin"
          >
            Fetch remote
          </button>
          {selectedIds.size > 0 ? (
            <button
              type="button"
              data-testid="bulk-archive"
              onClick={() => void bulkArchiveSelected()}
              disabled={busy}
            >
              Archive {selectedIds.size}
            </button>
          ) : null}
          <button
            type="button"
            data-testid="help-toggle"
            onClick={() => setShowHelp((v) => !v)}
            aria-expanded={showHelp}
          >
            ?
          </button>
          <span
            className="kb-status"
            data-testid="status"
            role="status"
            aria-live="polite"
          >
            {busy ? "…" : status}
          </span>
          <span
            className={`kb-sync kb-sync--${sync?.status ?? "synced"}`}
            data-testid="sync-status"
            title={sync?.lastError ?? sync?.label ?? "synced"}
            role="status"
            aria-live="polite"
            aria-label={sync?.label ?? "synced"}
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

      {needsConnect || boards.length === 0 ? (
        <div className="kb-connect" data-testid="connect-wizard">
          <h2>Connect a boards repo</h2>
          <p className="kb-muted">
            Paste a git remote URL (optional PAT) or a local path. Empty repos
            are scaffolded with a starter board.
          </p>
          <form
            className="kb-connect-form"
            onSubmit={(e) => {
              e.preventDefault();
              setConnectBusy(true);
              setError(null);
              connectRepo({
                url: connectUrl.trim() || undefined,
                path: connectPath.trim() || undefined,
                token: connectToken.trim() || undefined,
                scaffold: true,
              })
                .then(async (r) => {
                  setStatus(
                    `Connected ${r.path} · ${r.boards.length} board(s), ${r.cardCount} card(s)`,
                  );
                  if (r.slug) setRemoteSlug(r.slug);
                  if (r.remotes) setRemotes(r.remotes);
                  setConnectToken("");
                  await reload(r.boards[0]?.id);
                })
                .catch((err) => setError(String(err)))
                .finally(() => setConnectBusy(false));
            }}
          >
            <label>
              Remote URL
              <input
                data-testid="connect-url"
                placeholder="https://github.com/you/boards.git"
                value={connectUrl}
                onChange={(e) => setConnectUrl(e.target.value)}
              />
            </label>
            <label>
              Or local path
              <input
                data-testid="connect-path"
                placeholder="/path/to/boards"
                value={connectPath}
                onChange={(e) => setConnectPath(e.target.value)}
              />
            </label>
            <label>
              Optional PAT (HTTPS)
              <input
                data-testid="connect-token"
                type="password"
                value={connectToken}
                onChange={(e) => setConnectToken(e.target.value)}
                autoComplete="off"
              />
            </label>
            <button
              type="submit"
              data-testid="connect-submit"
              disabled={
                connectBusy || (!connectUrl.trim() && !connectPath.trim())
              }
            >
              {connectBusy ? "Connecting…" : "Connect"}
            </button>
          </form>
        </div>
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
            Re-enter a PAT for HTTPS remotes (stored under .kanbanly/, mode
            0600). SSH remotes still use your agent.
          </p>
          <form
            className="kb-cred-form"
            data-testid="credential-form"
            onSubmit={(e) => {
              e.preventDefault();
              setCredBusy(true);
              setCredentials({ token: credToken, username: credUser || undefined })
                .then(() => retrySync())
                .then((s) => {
                  setSync(s);
                  setCredToken("");
                  setStatus("Credential saved — push retried");
                })
                .catch((err) => setError(String(err)))
                .finally(() => setCredBusy(false));
            }}
          >
            <label>
              Username
              <input
                data-testid="credential-username"
                value={credUser}
                onChange={(e) => setCredUser(e.target.value)}
                autoComplete="username"
              />
            </label>
            <label>
              Token / PAT
              <input
                data-testid="credential-token"
                type="password"
                value={credToken}
                onChange={(e) => setCredToken(e.target.value)}
                autoComplete="current-password"
                required
              />
            </label>
            <button
              type="submit"
              data-testid="banner-credential-save"
              disabled={credBusy || !credToken.trim()}
            >
              Save &amp; retry
            </button>
            <button
              type="button"
              data-testid="banner-credential-retry"
              onClick={() => retrySync().then(setSync).catch((e) => setError(String(e)))}
            >
              Retry only
            </button>
          </form>
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
          {conflicts.length > 0 ? (
            <ul className="kb-conflict-list" data-testid="conflict-list">
              {conflicts.map((c) => (
                <li key={`${c.boardId}/${c.cardId}`} data-testid={`conflict-${c.cardId}`}>
                  <div className="kb-conflict-head">
                    <strong>{c.title ?? c.cardId}</strong>
                    <span className="kb-muted">{c.path}</span>
                  </div>
                  <div className="kb-conflict-sides">
                    <div>
                      <em>Mine</em>
                      <span>
                        {c.oursPreview?.column ?? "?"}
                        {c.oursPreview?.status ? ` — ${c.oursPreview.status}` : ""}
                      </span>
                    </div>
                    <div>
                      <em>Theirs</em>
                      <span>
                        {c.theirsPreview?.column ?? "?"}
                        {c.theirsPreview?.status
                          ? ` — ${c.theirsPreview.status}`
                          : ""}
                      </span>
                    </div>
                  </div>
                  <div className="kb-conflict-actions">
                    <button
                      type="button"
                      data-testid={`keep-mine-${c.cardId}`}
                      onClick={() =>
                        resolveConflict(c.boardId, c.cardId, "mine")
                          .then(async (r) => {
                            if (r.sync) setSync(r.sync);
                            await refreshConflicts();
                            await reload();
                            setStatus(
                              r.remaining === 0
                                ? "All conflicts resolved — sync unfrozen"
                                : `Kept mine · ${r.remaining} remaining`,
                            );
                          })
                          .catch((e) => setError(String(e)))
                      }
                    >
                      Keep mine
                    </button>
                    <button
                      type="button"
                      data-testid={`keep-theirs-${c.cardId}`}
                      onClick={() =>
                        resolveConflict(c.boardId, c.cardId, "theirs")
                          .then(async (r) => {
                            if (r.sync) setSync(r.sync);
                            await refreshConflicts();
                            await reload();
                            setStatus(
                              r.remaining === 0
                                ? "All conflicts resolved — sync unfrozen"
                                : `Kept theirs · ${r.remaining} remaining`,
                            );
                          })
                          .catch((e) => setError(String(e)))
                      }
                    >
                      Keep theirs
                    </button>
                    <button
                      type="button"
                      data-testid={`keep-heal-${c.cardId}`}
                      onClick={() =>
                        resolveConflict(c.boardId, c.cardId, "heal")
                          .then(async (r) => {
                            if (r.sync) setSync(r.sync);
                            await refreshConflicts();
                            await reload();
                            setStatus(
                              r.remaining === 0
                                ? "All conflicts resolved — sync unfrozen"
                                : `Healed · ${r.remaining} remaining`,
                            );
                          })
                          .catch((e) => setError(String(e)))
                      }
                    >
                      Heal merge
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="kb-banner-hint">
              No captured snapshots yet
              {sync?.conflictFiles?.length
                ? ` (files: ${sync.conflictFiles.join(", ")})`
                : ""}
              .
            </p>
          )}
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
            {filtersActive ? (
              <button
                type="button"
                data-testid="filter-clear"
                onClick={clearFilters}
              >
                Clear filters
              </button>
            ) : null}
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
            {remotes.length > 0 ? (
              <aside className="kb-sidebar" data-testid="remote-sidebar">
                <h3 className="kb-sidebar-title">Remotes</h3>
                <ul className="kb-remote-list">
                  {remotes.map((r) => (
                    <li
                      key={r.slug}
                      className={r.active ? "is-active" : undefined}
                      data-testid={`remote-${r.slug}`}
                    >
                      <button
                        type="button"
                        className="kb-remote-btn"
                        onClick={() =>
                          void switchRemote(r.slug, r.boards[0]?.id)
                        }
                      >
                        <strong>{r.label}</strong>
                        <span className="kb-muted">
                          {r.boards.length} board(s) · {r.cardCount} cards
                        </span>
                      </button>
                      {r.active ? (
                        <ul className="kb-remote-boards">
                          {r.boards.map((b) => (
                            <li key={b.id}>
                              <button
                                type="button"
                                data-testid={`sidebar-board-${b.id}`}
                                className={
                                  boardId === b.id ? "is-active" : undefined
                                }
                                onClick={() =>
                                  reload(b.id).catch((e) => setError(String(e)))
                                }
                              >
                                {b.id}
                                <span className="kb-muted">{b.cardCount}</span>
                              </button>
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </aside>
            ) : null}
            <div
              id="kb-main-board"
              className="kb-board"
              data-board-id={board.id}
              data-testid="board"
            >
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
                    prStatuses={prStatuses}
                    onQuickAdd={createInColumn}
                    selectedIds={selectedIds}
                    onToggleSelect={toggleSelect}
                    onArchiveOlder={                      col.id === "done" && (board.cardsByColumn.done?.length ?? 0) > 20
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
                boardId={board.id}
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
                          data-testid={`activity-card-${e.cardId}`}
                          onClick={() => {
                            const c = board.cards.find((x) => x.id === e.cardId);
                            if (c) {
                              setFocusedCardId(c.id);
                              setSelected(c);
                            } else {
                              setError(`Card not found: ${e.cardId}`);
                            }
                          }}
                        >
                          {e.cardTitle || e.cardId}
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

      {showHelp ? (
        <div
          className="kb-help-modal"
          data-testid="help-modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="kb-help-title"
        >
          <div className="kb-help-card">
            <div className="kb-panel-head">
              <strong id="kb-help-title">Keyboard shortcuts</strong>
              <button
                type="button"
                className="kb-panel-close"
                data-testid="help-close"
                onClick={() => setShowHelp(false)}
              >
                Close
              </button>
            </div>
            <ul className="kb-help-list">
              <li>
                <kbd>↑↓←→</kbd> / <kbd>hjkl</kbd> — move focus
              </li>
              <li>
                <kbd>Shift</kbd>+<kbd>←→</kbd> — move card between columns
              </li>
              <li>
                <kbd>Enter</kbd> / <kbd>Space</kbd> — open card
              </li>
              <li>
                <kbd>x</kbd> — toggle multi-select on focused card
              </li>
              <li>
                <kbd>Esc</kbd> — close panel / clear selection / close help
              </li>
              <li>
                <kbd>?</kbd> — toggle this help
              </li>
              <li>Cmd/Ctrl+click — multi-select cards</li>
              <li>Drag cards between or within columns</li>
            </ul>
          </div>
        </div>
      ) : null}
    </div>
  );
}
