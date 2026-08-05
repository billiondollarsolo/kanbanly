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
  formatSettingsPath,
  isFilterActive,
  isInnermostDropTarget,
  isSettingsSection,
  keyToMoveDirection,
  keyToNavDirection,
  keyboardMoveTarget,
  navigateFocus,
  readWindowAppRoute,
  renderMarkdown,
  resolveDropIndex,
  staticPrStatus,
  writeWindowAppRoute,
  checkDoingWip,
  formatPulseAge,
  isDoingColumn,
  writeWindowBoardRoute,
  type DropEdge,
  type NavBoard,
  type SettingsSection,
} from "@kanbanly/core";
import {
  addColumn,
  archiveCards,
  clearSyncFreeze,
  connectRepo,
  createBoard,
  createCard,
  deleteColumn,
  deleteCredentialBook,
  getActivity,
  getBoard,
  getBoardNotes,
  getCardHistory,
  connectCodeSource,
  getCodeHistory,
  getFleetHealth,
  getPortfolio,
  getSync,
  getWorkspace,
  listBoards,
  type FleetHealthResponse,
  type PortfolioResponse,
  listConflicts,
  listRemotes,
  moveCard,
  patchBoardBinding,
  patchConnection,
  pullRemote,
  putBoardNotes,
  remapColumn,
  renameColumn,
  reorderColumns,
  resolveConflict,
  retrySync,
  setActiveRemote,
  setCodeBinding,
  setCredentials,
  getPrStatuses,
  subscribeBoardEvents,
  updateCard,
  upsertCredentialBook,
  type ProjectCommit,
  type WorkspaceBoard,
  type WorkspaceCredential,
  type WorkspaceConnection,
  type WorkspaceSnapshot,
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

type ColumnDragData = {
  type: "column-drag";
  columnId: string;
  boardId: string;
};

function isCardDrag(data: Record<string | symbol, unknown>): data is CardDragData {
  return data.type === "card" && typeof data.cardId === "string";
}

function isColumnDrag(
  data: Record<string | symbol, unknown>,
): data is ColumnDragData {
  return data.type === "column-drag" && typeof data.columnId === "string";
}

/** Lightweight board-dir hint from a display name (settings UX). */
function slugifyHint(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
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
      className={`kb-card${dragging ? " kb-card--dragging" : ""}${focused ? " kb-card--focused" : ""}${selected ? " kb-card--selected" : ""}${onToggleSelect ? " kb-card--selectable" : ""}`}
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
      <div className="kb-card-body">
        {card.labels && card.labels.length > 0 ? (
          <div className="kb-labels">
            {card.labels.map((l) => (
              <span key={l} className="kb-label">
                {l}
              </span>
            ))}
          </div>
        ) : null}
        <div className="kb-card-title">{card.title}</div>
        <div className="kb-card-meta">
          {card.priority ? (
            <span className="kb-priority" data-testid={`priority-${card.id}`}>
              {card.priority}
            </span>
          ) : null}
          {card.due ? (
            <span className="kb-due" data-testid={`due-${card.id}`}>
              {card.due}
            </span>
          ) : null}
          <span className="kb-card-id">{card.id}</span>
          <span className="kb-card-meta-spacer" aria-hidden="true" />
          {card.assignee ? (
            <span className="kb-assignee">{card.assignee}</span>
          ) : null}
        </div>
        {card.pr ? <PrBadge pr={card.pr} live={prStatuses?.[card.pr]} /> : null}
      </div>
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

function CreateBoardForm({
  onCreate,
  busy,
}: {
  onCreate: (name: string) => Promise<void>;
  busy?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    const n = name.trim();
    if (!n || saving || busy) return;
    setSaving(true);
    try {
      await onCreate(n);
      setName("");
      setOpen(false);
    } finally {
      setSaving(false);
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        className="kb-toolbar-btn"
        data-testid="create-board-open"
        onClick={() => setOpen(true)}
        disabled={busy}
        title="Create a new board (layout A subdirectory)"
      >
        + Board
      </button>
    );
  }

  return (
    <div className="kb-create-board" data-testid="create-board">
      <input
        className="kb-create-board-input"
        data-testid="create-board-input"
        placeholder="Board name…"
        value={name}
        autoFocus
        disabled={saving || busy}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void submit();
          }
          if (e.key === "Escape") {
            setOpen(false);
            setName("");
          }
        }}
      />
      <button
        type="button"
        className="kb-toolbar-btn"
        data-testid="create-board-submit"
        disabled={!name.trim() || saving || busy}
        onClick={() => void submit()}
      >
        {saving ? "…" : "Create"}
      </button>
      <button
        type="button"
        className="kb-toolbar-btn"
        data-testid="create-board-cancel"
        onClick={() => {
          setOpen(false);
          setName("");
        }}
      >
        Cancel
      </button>
    </div>
  );
}

function AddListForm({
  onAdd,
  busy,
}: {
  onAdd: (name: string) => Promise<void>;
  busy?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    const n = name.trim();
    if (!n || saving || busy) return;
    setSaving(true);
    try {
      await onAdd(n);
      setName("");
      setOpen(false);
    } finally {
      setSaving(false);
    }
  };

  if (!open) {
    return (
      <div className="kb-add-list" data-testid="add-list">
        <button
          type="button"
          className="kb-add-list-open"
          data-testid="add-list-open"
          onClick={() => setOpen(true)}
          disabled={busy}
        >
          + column
        </button>
      </div>
    );
  }

  return (
    <div className="kb-add-list kb-add-list--open" data-testid="add-list">
      <input
        className="kb-add-list-input"
        data-testid="add-list-input"
        placeholder="Column name…"
        value={name}
        autoFocus
        disabled={saving || busy}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void submit();
          }
          if (e.key === "Escape") {
            setOpen(false);
            setName("");
          }
        }}
      />
      <div className="kb-add-list-actions">
        <button
          type="button"
          className="kb-add-list-submit"
          data-testid="add-list-submit"
          disabled={!name.trim() || saving || busy}
          onClick={() => void submit()}
        >
          {saving ? "…" : "add"}
        </button>
        <button
          type="button"
          className="kb-add-list-cancel"
          data-testid="add-list-cancel"
          onClick={() => {
            setOpen(false);
            setName("");
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function ColumnView({
  boardId,
  columnId,
  columnName,
  cards,
  onDropCard,
  onDropColumn,
  onOpenCard,
  onArchiveOlder,
  onQuickAdd,
  focusedCardId,
  onFocusCard,
  prStatuses,
  selectedIds,
  onToggleSelect,
  onRenameColumn,
  onMoveColumn,
  onDeleteColumn,
  canMoveLeft,
  canMoveRight,
  otherColumns,
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
  /** Drag list onto another list (left/right edge). */
  onDropColumn?: (
    draggedColumnId: string,
    targetColumnId: string,
    edge: "left" | "right",
  ) => Promise<void>;
  onOpenCard?: (card: BoardCard) => void;
  onArchiveOlder?: () => void;
  onQuickAdd?: (columnId: string, title: string) => Promise<void>;
  focusedCardId?: string | null;
  onFocusCard?: (cardId: string) => void;
  prStatuses?: Record<string, PrStatusResponse | null>;
  selectedIds?: Set<string>;
  onToggleSelect?: (cardId: string, multi: boolean) => void;
  onRenameColumn?: (columnId: string, name: string) => Promise<void>;
  onMoveColumn?: (columnId: string, direction: -1 | 1) => Promise<void>;
  onDeleteColumn?: (columnId: string, moveTo?: string) => Promise<void>;
  canMoveLeft?: boolean;
  canMoveRight?: boolean;
  otherColumns?: Array<{ id: string; name: string }>;
}) {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [headerEl, setHeaderEl] = useState<HTMLElement | null>(null);
  const [isOver, setIsOver] = useState(false);
  const [closestEdge, setClosestEdge] = useState<Edge | null>(null);
  const [overCardId, setOverCardId] = useState<string | null>(null);
  const [colDragging, setColDragging] = useState(false);
  const [colOverEdge, setColOverEdge] = useState<"left" | "right" | null>(null);
  const [quickTitle, setQuickTitle] = useState("");
  const [adding, setAdding] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(columnName);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteMoveTo, setDeleteMoveTo] = useState<string>("");

  // List header is the drag handle (cards keep their own drag on the body).
  useEffect(() => {
    if (!headerEl || !onDropColumn) return;
    return draggable({
      element: headerEl,
      canDrag: () => !renaming,
      getInitialData: (): ColumnDragData => ({
        type: "column-drag",
        columnId,
        boardId,
      }),
      onDragStart: () => {
        setColDragging(true);
        setMenuOpen(false);
      },
      onDrop: () => setColDragging(false),
    });
  }, [headerEl, columnId, boardId, renaming, onDropColumn]);

  // Column shell: card drops (empty / chrome) + list reorder (left/right edge).
  useEffect(() => {
    if (!el) return;
    const cardTarget = dropTargetForElements({
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

    if (!onDropColumn) return cardTarget;

    const listTarget = dropTargetForElements({
      element: el,
      getData: ({ input, element }) =>
        attachClosestEdge(
          { type: "column-drop" as const, columnId, boardId },
          { element, input, allowedEdges: ["left", "right"] },
        ),
      canDrop: ({ source }) =>
        isColumnDrag(source.data) && source.data.columnId !== columnId,
      onDragEnter: ({ self }) => {
        const edge = extractClosestEdge(self.data);
        setColOverEdge(edge === "left" || edge === "right" ? edge : null);
      },
      onDrag: ({ self }) => {
        const edge = extractClosestEdge(self.data);
        setColOverEdge(edge === "left" || edge === "right" ? edge : null);
      },
      onDragLeave: () => setColOverEdge(null),
      onDrop: async ({ source, self }) => {
        setColOverEdge(null);
        if (!isColumnDrag(source.data)) return;
        const edge = extractClosestEdge(self.data);
        if (edge !== "left" && edge !== "right") return;
        await onDropColumn(source.data.columnId, columnId, edge);
      },
    });

    return combine(cardTarget, listTarget);
  }, [el, boardId, columnId, cards, onDropCard, onDropColumn]);

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

  // Stable accent from column id (design color bar)
  const accentPalette = [
    "#4a7dbd",
    "#3f9c8f",
    "#5f9c4f",
    "#c08a2e",
    "#c0563e",
    "#8a6bc0",
    "#bb5f8a",
    "#77808a",
  ];
  let accentHash = 0;
  for (let i = 0; i < columnId.length; i++) {
    accentHash = (accentHash + columnId.charCodeAt(i) * (i + 1)) % 997;
  }
  const colAccent = accentPalette[accentHash % accentPalette.length]!;

  return (
    <section
      ref={setEl}
      className={`kb-column${isOver ? " kb-column--over" : ""}${colDragging ? " kb-column--dragging" : ""}${colOverEdge ? ` kb-column--drop-${colOverEdge}` : ""}`}
      data-column-id={columnId}
      data-testid={`column-${columnId}`}
      role="region"
      aria-label={`${columnName} column, ${cards.length} card${cards.length === 1 ? "" : "s"}`}
      style={{ ["--col-accent" as string]: colAccent }}
    >
      {colOverEdge === "left" ? (
        <div
          className="kb-column-drop-indicator kb-column-drop-indicator--left"
          data-testid={`col-drop-left-${columnId}`}
          aria-hidden="true"
        />
      ) : null}
      {colOverEdge === "right" ? (
        <div
          className="kb-column-drop-indicator kb-column-drop-indicator--right"
          data-testid={`col-drop-right-${columnId}`}
          aria-hidden="true"
        />
      ) : null}
      <div className="kb-column-accent" aria-hidden="true" />
      <header
        ref={setHeaderEl}
        className={`kb-column-header${onDropColumn ? " kb-column-header--drag" : ""}`}
        data-testid={`col-header-${columnId}`}
        title={onDropColumn ? "Drag to reorder list" : undefined}
      >
        {renaming ? (
          <input
            className="kb-column-rename"
            data-testid={`rename-input-${columnId}`}
            value={renameValue}
            autoFocus
            aria-label="Rename list"
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                const v = renameValue.trim();
                if (v && onRenameColumn) {
                  void onRenameColumn(columnId, v).then(() => setRenaming(false));
                }
              }
              if (e.key === "Escape") {
                setRenameValue(columnName);
                setRenaming(false);
              }
            }}
            onBlur={() => {
              const v = renameValue.trim();
              if (v && v !== columnName && onRenameColumn) {
                void onRenameColumn(columnId, v).then(() => setRenaming(false));
              } else {
                setRenameValue(columnName);
                setRenaming(false);
              }
            }}
          />
        ) : (
          <h3
            className="kb-column-name"
            id={`col-title-${columnId}`}
            data-testid={`col-title-${columnId}`}
            title="Drag to reorder · double-click to rename"
            onDoubleClick={() => {
              setRenameValue(columnName);
              setRenaming(true);
              setMenuOpen(false);
            }}
          >
            {columnName}
          </h3>
        )}
        <div className="kb-column-header-right">
          <span
            className="kb-column-count"
            data-testid={`count-${columnId}`}
            aria-label={`${cards.length} cards`}
          >
            {cards.length}
          </span>
          {onRenameColumn || onMoveColumn || onDeleteColumn ? (
            <div className="kb-col-menu-wrap">
              <button
                type="button"
                className="kb-col-menu-btn"
                data-testid={`col-menu-${columnId}`}
                aria-label={`List actions for ${columnName}`}
                aria-expanded={menuOpen}
                onClick={() => {
                  setMenuOpen((v) => !v);
                  setDeleteOpen(false);
                }}
              >
                ···
              </button>
              {menuOpen ? (
                <div className="kb-col-menu" data-testid={`col-menu-panel-${columnId}`} role="menu">
                  {onRenameColumn ? (
                    <button
                      type="button"
                      role="menuitem"
                      data-testid={`col-rename-${columnId}`}
                      onClick={() => {
                        setMenuOpen(false);
                        setRenameValue(columnName);
                        setRenaming(true);
                      }}
                    >
                      Rename list
                    </button>
                  ) : null}
                  {onMoveColumn && canMoveLeft ? (
                    <button
                      type="button"
                      role="menuitem"
                      data-testid={`col-move-left-${columnId}`}
                      onClick={() => {
                        setMenuOpen(false);
                        void onMoveColumn(columnId, -1);
                      }}
                    >
                      Move left
                    </button>
                  ) : null}
                  {onMoveColumn && canMoveRight ? (
                    <button
                      type="button"
                      role="menuitem"
                      data-testid={`col-move-right-${columnId}`}
                      onClick={() => {
                        setMenuOpen(false);
                        void onMoveColumn(columnId, 1);
                      }}
                    >
                      Move right
                    </button>
                  ) : null}
                  {onDeleteColumn ? (
                    <button
                      type="button"
                      role="menuitem"
                      className="kb-col-menu-danger"
                      data-testid={`col-delete-${columnId}`}
                      onClick={() => {
                        setDeleteOpen(true);
                        const first = otherColumns?.[0]?.id ?? "archive";
                        setDeleteMoveTo(cards.length > 0 ? first : "");
                      }}
                    >
                      Delete list…
                    </button>
                  ) : null}
                  {deleteOpen && onDeleteColumn ? (
                    <div className="kb-col-delete" data-testid={`col-delete-panel-${columnId}`}>
                      {cards.length > 0 ? (
                        <>
                          <p className="kb-muted">
                            {cards.length} card{cards.length === 1 ? "" : "s"} — move to:
                          </p>
                          <select
                            value={deleteMoveTo}
                            onChange={(e) => setDeleteMoveTo(e.target.value)}
                            data-testid={`col-delete-move-${columnId}`}
                          >
                            {(otherColumns ?? []).map((c) => (
                              <option key={c.id} value={c.id}>
                                {c.name}
                              </option>
                            ))}
                            <option value="archive">Archive all cards</option>
                          </select>
                        </>
                      ) : (
                        <p className="kb-muted">Delete empty list?</p>
                      )}
                      <div className="kb-col-delete-actions">
                        <button
                          type="button"
                          className="kb-col-menu-danger"
                          data-testid={`col-delete-confirm-${columnId}`}
                          onClick={() => {
                            setMenuOpen(false);
                            setDeleteOpen(false);
                            void onDeleteColumn(
                              columnId,
                              cards.length > 0 ? deleteMoveTo || undefined : undefined,
                            );
                          }}
                        >
                          Confirm delete
                        </button>
                        <button
                          type="button"
                          onClick={() => setDeleteOpen(false)}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
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
            placeholder="+ add card"
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
    <div
      className="kb-card-modal"
      data-testid="card-detail-overlay"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="kb-card-modal-dialog"
        data-testid="card-detail"
        data-card-id={card.id}
        role="dialog"
        aria-modal="true"
        aria-labelledby="kb-card-modal-title"
      >
        <header className="kb-card-modal-head">
          <div className="kb-card-modal-head-main">
            <code className="kb-card-modal-id" data-testid="detail-id">
              {card.id}
            </code>
            <input
              id="kb-card-modal-title"
              className="kb-card-modal-title"
              data-testid="detail-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              aria-label="Card title"
            />
          </div>
          <div className="kb-card-modal-actions">
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
            <button
              type="button"
              className="kb-card-modal-close"
              data-testid="detail-close"
              onClick={onClose}
              aria-label="Close"
            >
              ×
            </button>
          </div>
        </header>

        <div className="kb-card-modal-grid">
          <div className="kb-card-modal-main">
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
                  rows={6}
                  value={status}
                  onChange={(e) => setStatusText(e.target.value)}
                />
              ) : (
                <div
                  className="kb-md"
                  data-testid="detail-status-md"
                  dangerouslySetInnerHTML={{
                    __html: statusHtml || "<p><em>Empty</em></p>",
                  }}
                />
              )}
            </div>
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
                      <code className="kb-history-sha">
                        {h.sha.slice(0, 7)}
                      </code>
                      <span className="kb-history-subj">{h.subject}</span>
                      <span className="kb-muted">
                        {h.author} · {h.date.slice(0, 10)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          <aside className="kb-card-modal-side">
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
              Labels
              <input
                data-testid="detail-labels"
                value={labels}
                onChange={(e) => setLabels(e.target.value)}
                placeholder="comma-separated"
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
        </div>
      </div>
    </div>
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
  const [filterPriority, setFilterPriority] = useState("");
  const [themePref, setThemePref] = useState<ThemePreference>(() =>
    typeof document !== "undefined" ? readThemePreference() : "system",
  );
  const [showActivity, setShowActivity] = useState(false);
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [showNotes, setShowNotes] = useState(false);
  const [notesBody, setNotesBody] = useState("");
  const [notesBusy, setNotesBusy] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [historyCommits, setHistoryCommits] = useState<ProjectCommit[]>([]);
  const [historyMeta, setHistoryMeta] = useState<{
    bound: boolean;
    error: string | null;
    codePath: string | null;
  } | null>(null);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [codePathDraft, setCodePathDraft] = useState("");
  const [codeRemoteDraft, setCodeRemoteDraft] = useState("");
  const [codeTokenDraft, setCodeTokenDraft] = useState("");
  const [showPortfolio, setShowPortfolio] = useState(false);
  const [portfolio, setPortfolio] = useState<PortfolioResponse | null>(null);
  const [fleet, setFleet] = useState<FleetHealthResponse | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsNav, setSettingsNav] = useState<SettingsSection>("boards");
  const [boardMenuOpen, setBoardMenuOpen] = useState(false);
  const [workspace, setWorkspace] = useState<WorkspaceSnapshot | null>(null);
  const [expandedBoardKey, setExpandedBoardKey] = useState<string | null>(null);
  const [expandedConnectionId, setExpandedConnectionId] = useState<string | null>(
    null,
  );
  const [showAddBoard, setShowAddBoard] = useState(false);
  const [showAddConnection, setShowAddConnection] = useState(false);
  const [showAddCredential, setShowAddCredential] = useState(false);
  const [newBoardName, setNewBoardName] = useState("");
  const [newBoardDir, setNewBoardDir] = useState("");
  const [newBoardCred, setNewBoardCred] = useState("");
  const [newBoardRemote, setNewBoardRemote] = useState("");
  /** When adding a board against a brand-new repo connection */
  const [newBoardUseNewRepo, setNewBoardUseNewRepo] = useState(false);
  const [editBoardDraft, setEditBoardDraft] = useState<{
    key: string;
    label: string;
    boardDir: string;
    credentialId: string;
    remoteSlug: string;
  } | null>(null);
  const [newCredLabel, setNewCredLabel] = useState("");
  const [newCredToken, setNewCredToken] = useState("");
  const [newCredUser, setNewCredUser] = useState("x-access-token");
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
        ? readWindowAppRoute()
        : ({ kind: "home" } as const);
    if (route.kind === "settings") {
      setShowSettings(true);
      setSettingsNav(route.section);
      if (route.boardId) {
        setExpandedBoardKey(
          route.remoteSlug
            ? `${route.remoteSlug}::${route.boardId}`
            : route.boardId,
        );
      }
    }
    if (route.kind === "board" && route.remoteSlug) {
      setRemoteSlug(route.remoteSlug);
    }
    const routeBoardId =
      route.kind === "board"
        ? route.boardId
        : route.kind === "settings"
          ? route.boardId
          : null;
    const routeCardId = route.kind === "board" ? route.cardId : null;
    // Explicit id wins; else deep-linked board; home → portfolio (no auto-open first board)
    let target: string | null;
    if (id !== undefined) {
      target = id;
    } else if (routeBoardId) {
      target = routeBoardId;
    } else if (route.kind === "home") {
      target = null;
    } else {
      target = boardId;
    }
    setBoardId(target);
    if (target) {
      setShowPortfolio(false);
      try {
        const detail = await getBoard(target);
        setBoard(detail);
        if (!addColumn && detail.columns[0]) {
          // Prefer Ready for new-card column when present (agent pickup lane)
          const ready = detail.columns.find((c) => c.id === "ready");
          setAddColumn(ready?.id ?? detail.columns[0].id);
        }
        const wantCard = pendingCardId ?? routeCardId;
        if (wantCard) {
          const found = detail.cards.find((c) => c.id === wantCard);
          if (found) {
            setSelected(found);
            setFocusedCardId(found.id);
          } else if (routeCardId) {
            setError(`Card not found: ${routeCardId}`);
          }
          setPendingCardId(null);
        }
      } catch (e) {
        setBoard(null);
        setError(String(e));
      }
    } else {
      setBoard(null);
      setShowPortfolio(true);
      try {
        const [p, f] = await Promise.all([getPortfolio(), getFleetHealth()]);
        setPortfolio(p);
        setFleet(f);
      } catch {
        setPortfolio(null);
        setFleet(null);
      }
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
    if (typeof window !== "undefined") {
      const r = readWindowAppRoute();
      if (r.kind === "settings") {
        setShowSettings(true);
        setSettingsNav(r.section);
        if (r.boardId) {
          setExpandedBoardKey(
            r.remoteSlug ? `${r.remoteSlug}::${r.boardId}` : r.boardId,
          );
        }
      }
      if (r.kind === "board") {
        if (r.boardId) setBoardId(r.boardId);
        if (r.cardId) setPendingCardId(r.cardId);
        if (r.remoteSlug) setRemoteSlug(r.remoteSlug);
      }
    }
    reload().catch((e) => setError(String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep URL in sync: board/card OR settings sections
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (showSettings) {
      let settingsBoardId: string | null = null;
      let settingsRemote: string | null = null;
      if (expandedBoardKey?.includes("::")) {
        const [rs, bid] = expandedBoardKey.split("::");
        settingsRemote = rs ?? null;
        settingsBoardId = bid ?? null;
      } else if (settingsNav === "boards" && expandedBoardKey) {
        settingsBoardId = expandedBoardKey;
        settingsRemote = remoteSlug;
      }
      writeWindowAppRoute(
        {
          kind: "settings",
          section: settingsNav,
          remoteSlug: settingsNav === "boards" ? settingsRemote : null,
          boardId: settingsNav === "boards" ? settingsBoardId : null,
        },
        { replace: true },
      );
      return;
    }
    if (!boardId) return;
    writeWindowAppRoute(
      {
        kind: "board",
        boardId,
        cardId: selected?.id ?? null,
        remoteSlug,
      },
      { replace: true },
    );
  }, [
    boardId,
    selected?.id,
    remoteSlug,
    showSettings,
    settingsNav,
    expandedBoardKey,
  ]);

  // Browser back/forward
  useEffect(() => {
    const applyRoute = () => {
      const r = readWindowAppRoute();
      if (r.kind === "settings") {
        setShowSettings(true);
        setSettingsNav(r.section);
        if (r.boardId) {
          setExpandedBoardKey(
            r.remoteSlug ? `${r.remoteSlug}::${r.boardId}` : r.boardId,
          );
        } else {
          setExpandedBoardKey(null);
        }
        return;
      }
      setShowSettings(false);
      if (r.kind !== "board") return;
      const switchRemoteIfNeeded = async () => {
        if (r.remoteSlug && r.remoteSlug !== remoteSlug) {
          await setActiveRemote(r.remoteSlug);
          setRemoteSlug(r.remoteSlug);
        }
      };
      void switchRemoteIfNeeded()
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
      const moving = board.cards.find((c) => c.id === cardId);
      const alreadyThere = moving?.column === toColumn;
      if (isDoingColumn(toColumn) && !alreadyThere) {
        const doingN = (board.cardsByColumn.doing ?? board.cards.filter((c) =>
          isDoingColumn(c.column),
        )).length;
        const wip = checkDoingWip(doingN, board.settings, {
          movingIntoDoing: true,
        });
        if (wip.over && wip.message) {
          setStatus(`⚠ ${wip.message} (allowed — soft limit)`);
        }
      }
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
      setStatus((s) =>
        s.startsWith("⚠") ? s : `Moved ${cardId} → ${toColumn}`,
      );
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

  const onAddList = useCallback(
    async (name: string) => {
      if (!boardId) return;
      setBusy(true);
      setError(null);
      try {
        const res = await addColumn(boardId, name);
        if (res.sync) setSync(res.sync);
        setStatus(`Added list “${res.column.name}”`);
        await reload(boardId);
      } catch (e) {
        setError(String(e));
        throw e;
      } finally {
        setBusy(false);
      }
    },
    [boardId, reload],
  );

  const onRenameList = useCallback(
    async (columnId: string, name: string) => {
      if (!boardId) return;
      setBusy(true);
      setError(null);
      try {
        const res = await renameColumn(boardId, columnId, name);
        if (res.sync) setSync(res.sync);
        setStatus(`Renamed list to “${res.column.name}”`);
        await reload(boardId);
      } catch (e) {
        setError(String(e));
        throw e;
      } finally {
        setBusy(false);
      }
    },
    [boardId, reload],
  );

  const applyColumnOrder = useCallback(
    async (next: string[]) => {
      if (!boardId) return;
      setBusy(true);
      setError(null);
      try {
        // Optimistic local order for snappy UI
        setBoard((prev) => {
          if (!prev) return prev;
          const byId = new Map(prev.columns.map((c) => [c.id, c]));
          const columns = next
            .map((id) => byId.get(id))
            .filter((c): c is (typeof prev.columns)[number] => !!c);
          if (columns.length !== prev.columns.length) return prev;
          return { ...prev, columns };
        });
        const res = await reorderColumns(boardId, next);
        if (res.sync) setSync(res.sync);
        setStatus("Reordered lists");
        if (res.columns?.length) {
          setBoard((prev) =>
            prev ? { ...prev, columns: res.columns } : prev,
          );
        } else {
          await reload(boardId);
        }
      } catch (e) {
        setError(String(e));
        await reload(boardId);
      } finally {
        setBusy(false);
      }
    },
    [boardId, reload],
  );

  const onMoveList = useCallback(
    async (columnId: string, direction: -1 | 1) => {
      if (!boardId || !board) return;
      const ids = board.columns.map((c) => c.id);
      const idx = ids.indexOf(columnId);
      if (idx < 0) return;
      const j = idx + direction;
      if (j < 0 || j >= ids.length) return;
      const next = [...ids];
      const tmp = next[idx]!;
      next[idx] = next[j]!;
      next[j] = tmp;
      await applyColumnOrder(next);
    },
    [boardId, board, applyColumnOrder],
  );

  /** Drop a list relative to another (DnD). */
  const onDropList = useCallback(
    async (
      draggedColumnId: string,
      targetColumnId: string,
      edge: "left" | "right",
    ) => {
      if (!boardId || !board) return;
      if (draggedColumnId === targetColumnId) return;
      const ids = board.columns.map((c) => c.id);
      const from = ids.indexOf(draggedColumnId);
      const to = ids.indexOf(targetColumnId);
      if (from < 0 || to < 0) return;
      const next = [...ids];
      next.splice(from, 1);
      let insertAt = next.indexOf(targetColumnId);
      if (insertAt < 0) return;
      if (edge === "right") insertAt += 1;
      next.splice(insertAt, 0, draggedColumnId);
      // no-op if order unchanged
      if (next.every((id, i) => id === ids[i])) return;
      await applyColumnOrder(next);
    },
    [boardId, board, applyColumnOrder],
  );

  const onDeleteList = useCallback(
    async (columnId: string, moveTo?: string) => {
      if (!boardId) return;
      setBusy(true);
      setError(null);
      try {
        const res = await deleteColumn(boardId, columnId, moveTo);
        if (res.sync) setSync(res.sync);
        const extra =
          res.archived && res.archived > 0
            ? ` (archived ${res.archived})`
            : res.moved && res.moved > 0
              ? ` (moved ${res.moved})`
              : "";
        setStatus(`Deleted list ${columnId}${extra}`);
        await reload(boardId);
      } catch (e) {
        setError(String(e));
      } finally {
        setBusy(false);
      }
    },
    [boardId, reload],
  );

  const refreshWorkspace = useCallback(async () => {
    try {
      setWorkspace(await getWorkspace());
    } catch {
      /* ignore when offline */
    }
  }, []);

  useEffect(() => {
    if (showSettings) void refreshWorkspace();
  }, [showSettings, refreshWorkspace, remotes, boards]);

  useEffect(() => {
    if (showSettings && settingsNav === "activity") {
      setShowActivity(true);
    }
  }, [showSettings, settingsNav]);

  const onCreateBoard = useCallback(
    async (
      name: string,
      opts?: {
        credentialId?: string | null;
        remoteSlug?: string;
        boardDir?: string;
      },
    ) => {
      setBusy(true);
      setError(null);
      try {
        // Optional: connect a new repo first when creating a board against new path/url
        if (newBoardUseNewRepo && (connectUrl.trim() || connectPath.trim())) {
          const r = await connectRepo({
            url: connectUrl.trim() || undefined,
            path: connectPath.trim() || undefined,
            token: connectToken.trim() || undefined,
            scaffold: true,
          });
          if (r.slug) setRemoteSlug(r.slug);
          if (r.remotes) setRemotes(r.remotes);
          if (connectToken.trim()) {
            try {
              await upsertCredentialBook({
                label: connectUrl.trim() || connectPath.trim() || "GitHub PAT",
                token: connectToken.trim(),
              });
            } catch {
              /* optional */
            }
          }
          opts = { ...opts, remoteSlug: r.slug ?? opts?.remoteSlug };
          setConnectToken("");
        }

        const res = await createBoard(name, {
          credentialId: opts?.credentialId,
          remoteSlug: opts?.remoteSlug,
          // boardDir is display-only for new boards; id is always random `b-…`
          // unless tests pass id explicitly via API.
        });
        if (res.sync) setSync(res.sync);
        setStatus(`Created board “${res.boardId}”`);
        const listed = await listBoards();
        setBoards(listed.boards);
        setBoardId(res.boardId);
        await reload(res.boardId);
        await refreshWorkspace();
      } catch (e) {
        setError(String(e));
        throw e;
      } finally {
        setBusy(false);
      }
    },
    [
      reload,
      refreshWorkspace,
      newBoardUseNewRepo,
      connectUrl,
      connectPath,
      connectToken,
    ],
  );

  const openBoardEditor = useCallback((b: WorkspaceBoard) => {
    setExpandedBoardKey(b.key);
    setEditBoardDraft({
      key: b.key,
      label: b.label || b.boardId,
      boardDir: b.boardDir || b.boardId,
      credentialId: b.credentialId ?? "",
      remoteSlug: b.remoteSlug,
    });
  }, []);

  const saveBoardEditor = useCallback(async () => {
    if (!editBoardDraft) return;
    setBusy(true);
    setError(null);
    try {
      const fromRemoteSlug = editBoardDraft.key.split("::")[0]!;
      const boardId = editBoardDraft.key.split("::")[1]!;
      await patchBoardBinding({
        remoteSlug: editBoardDraft.remoteSlug,
        fromRemoteSlug,
        boardId,
        credentialId:
          editBoardDraft.credentialId === ""
            ? null
            : editBoardDraft.credentialId,
        label: editBoardDraft.label.trim() || boardId,
        boardDir: editBoardDraft.boardDir.trim() || boardId,
      });
      setStatus(`Saved board “${editBoardDraft.label || boardId}”`);
      // Keep editor open on new key if remote changed
      const newKey = `${editBoardDraft.remoteSlug}::${boardId}`;
      setExpandedBoardKey(newKey);
      setEditBoardDraft({ ...editBoardDraft, key: newKey });
      await refreshWorkspace();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [editBoardDraft, refreshWorkspace]);

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
    setFilterPriority("");
  }, []);

  const totalCardCount = board?.cards.length ?? 0;

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
      let colCards = filterCards(
        (board.cardsByColumn[col.id] ?? []).slice().sort((a, b) => {
          if (a.order < b.order) return -1;
          if (a.order > b.order) return 1;
          return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
        }),
        filter,
      );
      if (filterPriority) {
        colCards = colCards.filter((c) => (c.priority ?? "") === filterPriority);
      }
      cardsByColumn[col.id] = colCards.map((c) => ({
        id: c.id,
        column: c.column,
        order: c.order,
      }));
    }
    return { columns: board.columns, cardsByColumn };
  }, [board, filter, filterPriority]);

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

  const syncStatusTooltip = (() => {
    if (!sync) return "Sync status — local git commits vs remote";
    if (sync.lastError) return sync.lastError;
    const n = sync.pendingCount;
    switch (sync.status) {
      case "synced":
        return "All local commits are pushed to the remote.";
      case "pending":
        return n > 0
          ? `${n} local git commit${n === 1 ? "" : "s"} waiting to push. Click to push now.`
          : "Local commits waiting to push. Click to push now.";
      case "syncing":
        return "Pushing local commits to the remote…";
      case "offline":
        return n > 0
          ? `Remote unreachable. ${n} commit${n === 1 ? "" : "s"} will push when online. Click to retry.`
          : "Remote unreachable. Click to retry.";
      case "frozen":
        return "Sync paused due to a merge conflict. Resolve conflicts, then retry.";
      case "error":
        return "Last push failed. Click to retry.";
      case "no_remote":
        return n > 0
          ? `${n} local git commit${n === 1 ? "" : "s"} saved on disk. No git remote configured — nothing is waiting to upload. Click to open repository settings.`
          : "Working locally with no git remote. Click to open repository settings.";
      default:
        return sync.label;
    }
  })();

  const onSyncStatusClick = useCallback(() => {
    const st = sync?.status ?? "synced";
    if (st === "no_remote") {
      setBoardMenuOpen(false);
      setShowSettings(true);
      setSettingsNav("repositories");
      return;
    }
    if (st === "pending" || st === "error" || st === "offline" || st === "frozen") {
      setBusy(true);
      retrySync()
        .then((s) => {
          setSync(s);
          setStatus(
            s.status === "synced"
              ? "Pushed pending changes"
              : s.label,
          );
        })
        .catch((e) => setError(String(e)))
        .finally(() => setBusy(false));
      return;
    }
    // synced / syncing — still open repos for visibility
    setBoardMenuOpen(false);
    setShowSettings(true);
    setSettingsNav("repositories");
  }, [sync]);

  const brand = (
    <a className="kb-brand" href="/" data-testid="brand">
      <svg
        className="kb-logo-img"
        viewBox="0 0 512 512"
        width={24}
        height={24}
        aria-hidden="true"
        focusable="false"
      >
        <path
          fill="currentColor"
          d="M165.197,126.716c34.912,9.88,95.057,38.762,113.695,66.453C262.48,121.05,226.323,78.554,197.109,54.914 c-23.872-19.312-24.668-14.898-24.668-14.898c-3.44-2.08-7.777-2.041-11.179,0.116c-3.401,2.149-5.272,6.03-4.808,9.996 l1.817,15.956L165.197,126.716z"
        />
        <path
          fill="currentColor"
          d="M505.447,125.588c-23.703-8.797-59.263,1.956-79.997,3.92c-8.89-7.831-44.451-29.346-81.002-11.743 c-36.543,17.61-41.15,41.39-41.15,75.328c0,13.049-9.888,25.433-9.888,25.433c6.425,13.112,4.206,27.429,0.665,22.172 c-3.95-5.868-5.272-16.304-15.802-29.021c-77.036-101.566-261.412-79.889-261.412-79.889c-18.438,5.218-33.204,30.002,20.37,67.59 c60.871,42.704,127.177,88.014,153.462,105.887c21.105,14.348,24.53,42.704-5.264,54.772L48.471,412.21l69.955,38.979 l63.052-27.236l-48.502,34.518l28.75,15.044c0,0,79.015-45.642,135.31-78.907c52.747-31.162,83.964-66.522,92.854-117.39 c11.071-63.391,28.812-100.661,36.543-114.452c4.94-8.798,20.742-17.61,43.462-21.515c15.106-2.605,32.592-2.938,37.532-4.893 C512.366,134.401,515.327,130.489,505.447,125.588z"
        />
      </svg>
      <span className="kb-brand-text">
        <span className="kb-wordmark">kanbanly</span>
        <span className="kb-tagline">Kanban for ADHD</span>
      </span>
    </a>
  );

  const cycleTheme = () => {
    const order: ThemePreference[] = ["light", "dark", "system"];
    const i = order.indexOf(themePref);
    setThemePref(order[(i + 1) % order.length]!);
  };

  const themeGlyph =
    themePref === "light" ? "☀" : themePref === "dark" ? "☾" : "A";
  const themeTitle =
    themePref === "light"
      ? "Theme: light (click for dark)"
      : themePref === "dark"
        ? "Theme: dark (click for auto)"
        : "Theme: auto (click for light)";

  const boardPicker = (
    <div className="kb-board-picker" data-testid="board-picker">
      <button
        type="button"
        className="kb-board-picker-btn"
        data-testid="board-select"
        aria-expanded={boardMenuOpen}
        aria-haspopup="listbox"
        onClick={() => setBoardMenuOpen((v) => !v)}
      >
        <span className="kb-board-picker-label">board</span>
        <span className="kb-board-picker-title" data-testid="board-id">
          {board?.title ||
            boards.find((b) => b.id === boardId)?.title ||
            boardId ||
            "—"}
        </span>
        <span className="kb-board-picker-caret" aria-hidden="true">
          ▼
        </span>
      </button>
      <span
        className="kb-card-count-badge"
        data-testid="card-count-badge"
        title="Cards on this board"
      >
        {totalCardCount}
      </span>
      {boardMenuOpen ? (
        <div
          className="kb-board-menu"
          data-testid="board-menu"
          role="listbox"
          aria-label="Boards"
        >
          <div className="kb-board-menu-heading">boards</div>
          <div className="kb-board-menu-list">
            {boards.map((b) => (
              <button
                key={b.id}
                type="button"
                role="option"
                aria-selected={b.id === boardId}
                className={
                  b.id === boardId
                    ? "kb-board-menu-item is-active"
                    : "kb-board-menu-item"
                }
                data-testid={`board-menu-item-${b.id}`}
                onClick={() => {
                  setBoardMenuOpen(false);
                  setBoardId(b.id);
                  reload(b.id).catch((err) => setError(String(err)));
                }}
              >
                <span title={b.id}>{b.title || b.id}</span>
                <span className="kb-board-menu-count">{b.cardCount}</span>
              </button>
            ))}
          </div>
          <button
            type="button"
            className="kb-board-menu-new"
            data-testid="board-menu-new"
            onClick={() => {
              setBoardMenuOpen(false);
              const name = window.prompt("New board name");
              if (name?.trim()) void onCreateBoard(name.trim());
            }}
          >
            + new board
          </button>
        </div>
      ) : null}
    </div>
  );

  const openPortfolio = useCallback(() => {
    setShowPortfolio(true);
    setBoardId(null);
    setBoard(null);
    setSelected(null);
    writeWindowBoardRoute(null, null, remoteSlug);
    Promise.all([getPortfolio(), getFleetHealth()])
      .then(([p, f]) => {
        setPortfolio(p);
        setFleet(f);
      })
      .catch((e) => setError(String(e)));
  }, [remoteSlug]);

  const openBoardFromPortfolio = useCallback(
    (id: string) => {
      setShowPortfolio(false);
      writeWindowBoardRoute(id, null, remoteSlug);
      void reload(id);
    },
    [remoteSlug, reload],
  );

  const appHeader = (
    <header className="kb-navbar" data-testid="app-navbar">
      {brand}
      {boards.length > 0 ? (
        <button
          type="button"
          className={`kb-toolbar-btn${showPortfolio ? " is-on" : ""}`}
          data-testid="portfolio-open"
          title="All projects at a glance"
          onClick={openPortfolio}
        >
          Projects
        </button>
      ) : null}
      {boards.length > 0 || boardId ? boardPicker : null}
      <div className="kb-navbar-grow" aria-hidden="true" />
      <label className="kb-header-filter" data-testid="filter-bar">
        <span className="kb-header-filter-slash" aria-hidden="true">
          /
        </span>
        <input
          type="search"
          placeholder="filter cards"
          value={filterQuery}
          onChange={(e) => setFilterQuery(e.target.value)}
          data-testid="filter-query"
        />
      </label>
      <div
        className="kb-priority-seg"
        role="group"
        aria-label="Priority filter"
        data-testid="priority-filter"
      >
        {(["", "P0", "P1", "P2"] as const).map((p) => (
          <button
            key={p || "all"}
            type="button"
            className={filterPriority === p ? "is-on" : undefined}
            data-testid={`priority-filter-${p || "all"}`}
            onClick={() => setFilterPriority(p)}
          >
            {p || "all"}
          </button>
        ))}
      </div>
      {boardId ? (
        <>
          <button
            type="button"
            className="kb-toolbar-btn"
            data-testid="board-notes-open"
            title="Project notes (NOTES.md)"
            onClick={() => {
              if (!boardId) return;
              setShowNotes(true);
              setNotesBusy(true);
              getBoardNotes(boardId)
                .then((r) => setNotesBody(r.body))
                .catch((e) => setError(String(e)))
                .finally(() => setNotesBusy(false));
            }}
          >
            Notes
          </button>
          <button
            type="button"
            className="kb-toolbar-btn"
            data-testid="board-history-open"
            title="Project code commits (not boards git log)"
            onClick={() => {
              if (!boardId) return;
              setShowHistory(true);
              setHistoryBusy(true);
              getCodeHistory(boardId)
                .then((r) => {
                  setHistoryCommits(r.commits);
                  setHistoryMeta({
                    bound: r.bound,
                    error: r.error,
                    codePath: r.codePath,
                  });
                  setCodePathDraft(r.binding?.path ?? r.codePath ?? "");
                  setCodeRemoteDraft(r.binding?.remote ?? "");
                })
                .catch((e) => setError(String(e)))
                .finally(() => setHistoryBusy(false));
            }}
          >
            History
          </button>
        </>
      ) : null}
      <button
        type="button"
        className={`kb-sync kb-sync--${sync?.status ?? "synced"}`}
        data-testid="sync-status"
        title={syncStatusTooltip}
        aria-live="polite"
        aria-label={sync?.label ?? "synced"}
        onClick={onSyncStatusClick}
      >
        {busy ? "…" : (sync?.label ?? "○ local")}
      </button>
      {selectedIds.size > 0 ? (
        <button
          type="button"
          className="kb-icon-btn"
          data-testid="bulk-archive"
          onClick={() => void bulkArchiveSelected()}
          disabled={busy}
          title={`Archive ${selectedIds.size} selected`}
        >
          ⌫
        </button>
      ) : null}
      <button
        type="button"
        className="kb-icon-btn"
        data-testid="theme-select"
        data-theme-pref={themePref}
        title={themeTitle}
        aria-label={themeTitle}
        onClick={cycleTheme}
      >
        <span data-testid={`theme-${themePref}`}>{themeGlyph}</span>
      </button>
      <button
        type="button"
        className="kb-icon-btn"
        data-testid="settings-toggle"
        title="Settings"
        aria-expanded={showSettings}
        onClick={() => {
          setBoardMenuOpen(false);
          setShowSettings((v) => {
            if (!v) setSettingsNav("boards");
            return !v;
          });
        }}
      >
        ⚙
      </button>
      <button
        type="button"
        className="kb-icon-btn"
        data-testid="help-toggle"
        title="Keyboard shortcuts"
        aria-expanded={showHelp}
        onClick={() => setShowHelp((v) => !v)}
      >
        ?
      </button>
    </header>
  );

  if (error && !board) {
    return (
      <div className="kb-app">
        {appHeader}
        <div className="kb-board-body">
          <p className="kb-error" data-testid="error">
            {error}
          </p>
          <p className="kb-muted">
            Connect a boards repo with <code>--repo &lt;path&gt;</code>, or open
            Settings ⚙.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      className="kb-app"
      data-testid="board-app"
      onKeyDown={onBoardKeyDown}
      tabIndex={-1}
      onClick={() => {
        if (boardMenuOpen) setBoardMenuOpen(false);
      }}
    >
      <a href="#kb-main-board" className="kb-skip-link" data-testid="skip-link">
        Skip to board
      </a>
      <div
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        {appHeader}
      </div>

      <div className="kb-board-body">
      {error ? (
        <p className="kb-error" data-testid="error">
          {error}
        </p>
      ) : null}

      {showPortfolio && !needsConnect && boards.length > 0 ? (
        <div className="kb-portfolio" data-testid="portfolio-home">
          <div className="kb-portfolio-head">
            <h2 className="kb-portfolio-title">Projects</h2>
            <p className="kb-muted" data-testid="portfolio-summary">
              Multi-project home
              {portfolio
                ? ` · ${portfolio.p0Total} P0 · ${portfolio.staleTotal} stale`
                : ""}
              {portfolio?.velocity
                ? ` · 7d: ${portfolio.velocity.done7d} done · ${portfolio.velocity.codeCommits24h} code commits/24h · ${portfolio.velocity.agentEvents7d} agent logs`
                : ""}
              {fleet
                ? ` · fleet ${fleet.ok ? "ok" : `${fleet.highCount} high`}`
                : ""}
            </p>
          </div>
          {fleet && fleet.highCount > 0 ? (
            <div
              className="kb-banner kb-banner--offline"
              data-testid="fleet-alerts"
              role="alert"
            >
              <strong>Fleet needs attention ({fleet.highCount} high)</strong>
              <ul className="kb-activity-list">
                {fleet.issues
                  .filter((i) => i.severity === "high")
                  .slice(0, 8)
                  .map((i, idx) => (
                    <li key={`${i.boardId}-${i.kind}-${idx}`}>
                      <button
                        type="button"
                        className="kb-activity-card"
                        onClick={() => openBoardFromPortfolio(i.boardId)}
                      >
                        {i.boardTitle}
                      </button>
                      <span className="kb-activity-line">{i.message}</span>
                    </li>
                  ))}
              </ul>
            </div>
          ) : null}
          <div className="kb-portfolio-grid">
            {(portfolio?.tiles ?? []).map((t) => (
              <button
                key={t.boardId}
                type="button"
                className={`kb-portfolio-tile kb-portfolio-tile--${t.health ?? "idle"}`}
                data-testid={`portfolio-tile-${t.boardId}`}
                data-health={t.health ?? "idle"}
                onClick={() => openBoardFromPortfolio(t.boardId)}
              >
                <div className="kb-portfolio-tile-top">
                  <strong>{t.title}</strong>
                  <span
                    className={`kb-portfolio-health kb-portfolio-health--${t.health ?? "idle"}`}
                    data-testid={`portfolio-health-${t.boardId}`}
                  >
                    {t.health ?? "idle"}
                  </span>
                </div>
                <div className="kb-portfolio-velocity" data-testid={`portfolio-vel-${t.boardId}`}>
                  <span>
                    {t.velocity?.done7d ?? 0} done/7d
                  </span>
                  <span>
                    {t.velocity?.codeCommits7d == null
                      ? "code —"
                      : `${t.velocity.codeCommits7d} commits/7d`}
                  </span>
                  <span>
                    {formatPulseAge(t.velocity?.pulseAgeHours ?? null)}
                  </span>
                </div>
                <div className="kb-portfolio-badges">
                  {t.p0Count > 0 ? (
                    <span className="kb-portfolio-badge kb-portfolio-badge--p0">
                      {t.p0Count} P0
                    </span>
                  ) : null}
                  {(t.readyCount ?? 0) > 0 ? (
                    <span className="kb-portfolio-badge">
                      {t.readyCount} ready
                    </span>
                  ) : null}
                  {t.doingCount > 0 ? (
                    <span className="kb-portfolio-badge">
                      {t.doingCount} doing
                    </span>
                  ) : null}
                  {t.blockedCount > 0 ? (
                    <span className="kb-portfolio-badge kb-portfolio-badge--blocked">
                      {t.blockedCount} blocked
                    </span>
                  ) : null}
                  {t.staleDoingCount > 0 ? (
                    <span className="kb-portfolio-badge kb-portfolio-badge--stale">
                      {t.staleDoingCount} stale
                    </span>
                  ) : null}
                  {t.wipDoing?.over ? (
                    <span className="kb-portfolio-badge kb-portfolio-badge--stale">
                      WIP {t.wipDoing.count}/{t.wipDoing.limit}
                    </span>
                  ) : t.wipDoing ? (
                    <span className="kb-portfolio-badge">
                      WIP {t.wipDoing.count}/{t.wipDoing.limit}
                    </span>
                  ) : null}
                  {t.codeBound ? (
                    <span className="kb-portfolio-badge kb-portfolio-badge--code">
                      source
                    </span>
                  ) : null}
                </div>
                <div className="kb-portfolio-meta kb-muted">
                  {t.cardCount} cards
                  {t.lastAgent ? ` · agent ${t.lastAgent}` : ""}
                  {t.velocity?.agentEvents7d
                    ? ` · ${t.velocity.agentEvents7d} agent logs/7d`
                    : ""}
                  {t.lastActivity
                    ? ` · ${t.lastActivity.line.slice(0, 48)}`
                    : ""}
                </div>
              </button>
            ))}
          </div>
          {(portfolio?.activity?.length ?? 0) > 0 ? (
            <section className="kb-portfolio-activity" data-testid="portfolio-activity">
              <h3 className="kb-settings-section-title">Recent activity</h3>
              <ul className="kb-activity-list">
                {portfolio!.activity.slice(0, 20).map((e, i) => (
                  <li key={`${e.boardId}-${e.cardId}-${i}`}>
                    <span className="kb-activity-date">{e.date}</span>
                    <button
                      type="button"
                      className="kb-activity-card"
                      onClick={() => openBoardFromPortfolio(e.boardId)}
                    >
                      {e.boardTitle}
                    </button>
                    <span className="kb-muted">{e.cardTitle}</span>
                    <span className="kb-activity-line">{e.line}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
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
                  // Land on portfolio home (multi-project radar), not a random first board
                  writeWindowBoardRoute(null, null, r.slug ?? null);
                  await reload();
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

      {board && !showPortfolio ? (
        <>
          {(() => {
            const doingN = board.cards.filter((c) =>
              isDoingColumn(c.column),
            ).length;
            const wip = checkDoingWip(doingN, board.settings);
            if (!wip.over) return null;
            return (
              <div
                className="kb-banner kb-banner--offline"
                data-testid="wip-banner"
                role="status"
              >
                <strong>Doing WIP soft limit</strong>
                <p>
                  {doingN} cards in Doing (limit {wip.limit}). Prefer finishing
                  or moving work to Review/Blocked before starting more Ready
                  items.
                </p>
              </div>
            );
          })()}
          {(filtersActive || filterPriority) ? (
            <div className="kb-filter-chip-row">
              <span className="kb-muted">
                Filters active
                {filterQuery ? ` · “${filterQuery}”` : ""}
                {filterPriority ? ` · ${filterPriority}` : ""}
                {filterLabel ? ` · label:${filterLabel}` : ""}
                {filterAssignee ? ` · @${filterAssignee}` : ""}
              </span>
              <button
                type="button"
                className="kb-toolbar-btn"
                data-testid="filter-clear"
                onClick={clearFilters}
              >
                Clear
              </button>
            </div>
          ) : null}

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
            <div
              id="kb-main-board"
              className="kb-board"
              data-board-id={board.id}
              data-testid="board"
            >
              {columns.map((col, colIndex) => {
                let colCards = filterCards(
                  (board.cardsByColumn[col.id] ?? [])
                    .slice()
                    .sort((a, b) => {
                      if (a.order < b.order) return -1;
                      if (a.order > b.order) return 1;
                      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
                    }),
                  filter,
                );
                if (filterPriority) {
                  colCards = colCards.filter(
                    (c) => (c.priority ?? "") === filterPriority,
                  );
                }
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
                    onRenameColumn={onRenameList}
                    onMoveColumn={onMoveList}
                    onDropColumn={columns.length > 1 ? onDropList : undefined}
                    onDeleteColumn={
                      columns.length > 1 ? onDeleteList : undefined
                    }
                    canMoveLeft={colIndex > 0}
                    canMoveRight={colIndex < columns.length - 1}
                    otherColumns={columns
                      .filter((c) => c.id !== col.id)
                      .map((c) => ({ id: c.id, name: c.name }))}
                  />
                );
              })}
              <AddListForm onAdd={onAddList} busy={busy} />
            </div>
          </div>
        </>
      ) : (
        <p data-testid="empty-state">No boards connected.</p>
      )}
      </div>

      {selected && board ? (
        <DetailPanel
          card={board.cards.find((c) => c.id === selected.id) ?? selected}
          boardId={board.id}
          onClose={() => setSelected(null)}
          onSave={onSaveDetail}
          busy={busy}
        />
      ) : null}

      {showNotes && boardId ? (
        <div
          className="kb-card-modal"
          data-testid="board-notes-modal"
          role="presentation"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setShowNotes(false);
          }}
        >
          <div
            className="kb-card-modal-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="kb-notes-title"
          >
            <header className="kb-card-modal-head">
              <div className="kb-card-modal-head-main">
                <strong id="kb-notes-title">Project notes</strong>
                <p className="kb-muted" style={{ margin: 0 }}>
                  NOTES.md in the board directory (boards git). Shared by humans
                  and agents.
                </p>
              </div>
              <button
                type="button"
                className="kb-card-modal-close"
                data-testid="board-notes-close"
                aria-label="Close"
                onClick={() => setShowNotes(false)}
              >
                ×
              </button>
            </header>
            <textarea
              className="kb-notes-editor"
              data-testid="board-notes-body"
              rows={16}
              value={notesBody}
              disabled={notesBusy}
              onChange={(e) => setNotesBody(e.target.value)}
              spellCheck
            />
            <div className="kb-card-modal-actions" style={{ marginTop: 12 }}>
              <button
                type="button"
                className="kb-panel-save"
                data-testid="board-notes-save"
                disabled={notesBusy || busy}
                style={{ width: "auto", minWidth: 120 }}
                onClick={() => {
                  setNotesBusy(true);
                  putBoardNotes(boardId, notesBody)
                    .then(() => {
                      setStatus("Saved project notes");
                      setShowNotes(false);
                    })
                    .catch((e) => setError(String(e)))
                    .finally(() => setNotesBusy(false));
                }}
              >
                Save notes
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {showHistory && boardId ? (
        <div
          className="kb-card-modal"
          data-testid="board-history-modal"
          role="presentation"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setShowHistory(false);
          }}
        >
          <div
            className="kb-card-modal-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="kb-history-title"
          >
            <header className="kb-card-modal-head">
              <div className="kb-card-modal-head-main">
                <strong id="kb-history-title">Project commits</strong>
                <p className="kb-muted" style={{ margin: 0 }}>
                  Code repository history (not boards-repo chore commits).
                </p>
              </div>
              <button
                type="button"
                className="kb-card-modal-close"
                data-testid="board-history-close"
                aria-label="Close"
                onClick={() => setShowHistory(false)}
              >
                ×
              </button>
            </header>
            <label className="kb-field">
              Source remote URL
              <input
                data-testid="board-code-remote"
                value={codeRemoteDraft}
                onChange={(e) => setCodeRemoteDraft(e.target.value)}
                placeholder="https://github.com/you/app.git"
              />
            </label>
            <label className="kb-field">
              Or local path
              <input
                data-testid="board-code-path"
                value={codePathDraft}
                onChange={(e) => setCodePathDraft(e.target.value)}
                placeholder="/absolute/path/to/project"
              />
            </label>
            <label className="kb-field">
              PAT (optional — uses board credential if empty)
              <input
                data-testid="board-code-token"
                type="password"
                autoComplete="off"
                value={codeTokenDraft}
                onChange={(e) => setCodeTokenDraft(e.target.value)}
                placeholder="ghp_… fine-grained: Contents R/W"
              />
            </label>
            <div className="kb-card-modal-actions" style={{ marginBottom: 12 }}>
              <button
                type="button"
                className="kb-toolbar-btn"
                data-testid="board-code-connect"
                disabled={
                  historyBusy ||
                  (!codePathDraft.trim() && !codeRemoteDraft.trim())
                }
                onClick={() => {
                  setHistoryBusy(true);
                  const payload = {
                    path: codePathDraft.trim() || undefined,
                    url: codeRemoteDraft.trim() || undefined,
                    token: codeTokenDraft.trim() || undefined,
                  };
                  const run = codeRemoteDraft.trim()
                    ? connectCodeSource(boardId, payload)
                    : setCodeBinding(boardId, payload);
                  run
                    .then((res) => {
                      if (res.history) {
                        setHistoryCommits(res.history.commits);
                        setHistoryMeta({
                          bound: res.history.bound,
                          error: res.history.error,
                          codePath: res.history.codePath,
                        });
                      }
                      if (res.source?.path) {
                        setCodePathDraft(res.source.path);
                      }
                      setCodeTokenDraft("");
                      setStatus(
                        res.source?.cloned
                          ? "Cloned source repo and linked History"
                          : res.history?.bound
                            ? "Linked source repo for History"
                            : res.history?.error || "Source binding saved",
                      );
                      return getCodeHistory(boardId);
                    })
                    .then((r) => {
                      setHistoryCommits(r.commits);
                      setHistoryMeta({
                        bound: r.bound,
                        error: r.error,
                        codePath: r.codePath,
                      });
                      if (r.binding?.path) setCodePathDraft(r.binding.path);
                      if (r.binding?.remote) setCodeRemoteDraft(r.binding.remote);
                    })
                    .catch((e) => setError(String(e)))
                    .finally(() => setHistoryBusy(false));
                }}
              >
                Connect source
              </button>
            </div>
            {historyBusy ? (
              <p className="kb-muted">Loading…</p>
            ) : historyMeta && !historyMeta.bound ? (
              <p className="kb-muted" data-testid="board-history-unbound">
                {historyMeta.error ||
                  "No source code repo bound. Paste a remote URL (with PAT) or a local path."}
              </p>
            ) : historyCommits.length === 0 ? (
              <p className="kb-muted" data-testid="board-history-empty">
                No commits found in the bound project repo.
              </p>
            ) : (
              <ul className="kb-history-list" data-testid="board-history-list">
                {historyCommits.map((c) => (
                  <li key={c.sha} data-testid="project-commit">
                    <code className="kb-history-sha">{c.sha.slice(0, 7)}</code>
                    {c.url ? (
                      <a
                        className="kb-history-subj"
                        href={c.url}
                        target="_blank"
                        rel="noreferrer"
                        data-testid="project-commit-link"
                      >
                        {c.subject}
                      </a>
                    ) : (
                      <span className="kb-history-subj">{c.subject}</span>
                    )}
                    {c.cardIds && c.cardIds.length > 0 ? (
                      <span className="kb-commit-cards">
                        {c.cardIds.map((cid) => (
                          <button
                            key={cid}
                            type="button"
                            className="kb-linkish"
                            data-testid={`commit-card-${cid}`}
                            onClick={() => {
                              const found = board?.cards.find(
                                (x) => x.id.toLowerCase() === cid,
                              );
                              if (found) {
                                setSelected(found);
                                setFocusedCardId(found.id);
                                setShowHistory(false);
                              }
                            }}
                          >
                            {cid}
                          </button>
                        ))}
                      </span>
                    ) : null}
                    <span className="kb-muted">
                      {c.author} · {c.date.slice(0, 10)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : null}

      {showSettings ? (
        <div
          className="kb-settings"
          data-testid="settings-panel"
          role="dialog"
          aria-modal="true"
          aria-labelledby="kb-settings-title"
        >
          <header className="kb-navbar kb-settings-header" data-testid="settings-navbar">
            {brand}
            <div className="kb-settings-header-mid">
              <span className="kb-settings-admin">admin</span>
              <strong id="kb-settings-title" className="kb-settings-title">
                Settings
              </strong>
            </div>
            <div className="kb-navbar-grow" aria-hidden="true" />
            <button
              type="button"
              className="kb-toolbar-btn"
              data-testid="settings-close"
              onClick={() => setShowSettings(false)}
            >
              ← board
            </button>
          </header>
          <div className="kb-settings-shell">
            <nav className="kb-settings-nav" aria-label="Settings sections" data-testid="settings-nav">
              <div className="kb-settings-nav-label">settings</div>
              {(
                [
                  ["boards", "Boards"],
                  ["repositories", "Repositories"],
                  ["credentials", "Credentials"],
                  ["filters", "Filters"],
                  ["theme", "Theme"],
                  ["activity", "Activity"],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  className={
                    settingsNav === id
                      ? "kb-settings-nav-item is-active"
                      : "kb-settings-nav-item"
                  }
                  data-testid={`settings-nav-${id}`}
                  aria-current={settingsNav === id ? "page" : undefined}
                  onClick={() => setSettingsNav(id)}
                >
                  {label}
                </button>
              ))}
            </nav>
            <div className="kb-settings-main">
            {settingsNav === "boards" ? (
            <section className="kb-settings-section" data-testid="settings-boards">
              <div className="kb-settings-section-head">
                <h3 className="kb-settings-section-title">boards</h3>
                <button
                  type="button"
                  className="kb-toolbar-btn"
                  data-testid="settings-add-board-toggle"
                  onClick={() => {
                    setShowAddBoard((v) => !v);
                    if (!showAddBoard) {
                      setNewBoardRemote(workspace?.activeRemote ?? "");
                      setNewBoardUseNewRepo(
                        !(workspace?.connections?.length),
                      );
                    }
                  }}
                >
                  {showAddBoard ? "cancel" : "+ add board"}
                </button>
              </div>
              <p className="kb-muted">
                Configure each board here: credentials, git repository, and the
                directory inside that repo (layout A). Expand a board to edit.
              </p>

              {showAddBoard ? (
                <div className="kb-disclose" data-testid="settings-add-board">
                  <p className="kb-disclose-step">
                    <span className="kb-disclose-step-n">1</span> Identity
                  </p>
                  <label>
                    Board name
                    <input
                      value={newBoardName}
                      onChange={(e) => {
                        setNewBoardName(e.target.value);
                        if (!newBoardDir || newBoardDir === slugifyHint(newBoardName)) {
                          /* keep dir in sync while typing if user hasn&apos;t customized */
                        }
                        setNewBoardDir((d) =>
                          !d || d === slugifyHint(newBoardName)
                            ? slugifyHint(e.target.value)
                            : d,
                        );
                      }}
                      placeholder="e.g. Mobile app"
                      data-testid="settings-new-board-name"
                    />
                  </label>
                  <label>
                    Directory in repo
                    <input
                      value={newBoardDir}
                      onChange={(e) => setNewBoardDir(e.target.value)}
                      placeholder="mobile-app"
                      data-testid="settings-new-board-dir"
                    />
                  </label>
                  <span className="kb-muted">
                    Multi-board repos use one git root with a folder per board.
                    Single-board repos use directory <code>.</code> (root).
                  </span>

                  <p className="kb-disclose-step">
                    <span className="kb-disclose-step-n">2</span> Credentials
                  </p>
                  <label>
                    Credential for push / fetch
                    <select
                      value={newBoardCred}
                      onChange={(e) => setNewBoardCred(e.target.value)}
                      data-testid="settings-new-board-cred"
                    >
                      <option value="">None yet (add below or use SSH agent)</option>
                      {(workspace?.credentials ?? []).map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.label} ({c.username})
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    className="kb-linkish"
                    onClick={() => setShowAddCredential(true)}
                  >
                    + add a named credential
                  </button>

                  <p className="kb-disclose-step">
                    <span className="kb-disclose-step-n">3</span> Repository
                  </p>
                  <div className="kb-seg-row" role="group" aria-label="Repository source">
                    <button
                      type="button"
                      className={!newBoardUseNewRepo ? "is-on" : undefined}
                      disabled={(workspace?.connections.length ?? 0) === 0}
                      onClick={() => setNewBoardUseNewRepo(false)}
                    >
                      Existing repo
                    </button>
                    <button
                      type="button"
                      className={newBoardUseNewRepo ? "is-on" : undefined}
                      onClick={() => setNewBoardUseNewRepo(true)}
                    >
                      New / enter repo
                    </button>
                  </div>
                  {!newBoardUseNewRepo ? (
                    <label>
                      Connected repository
                      <select
                        value={newBoardRemote}
                        onChange={(e) => setNewBoardRemote(e.target.value)}
                        data-testid="settings-new-board-remote"
                      >
                        <option value="">Select…</option>
                        {(workspace?.connections ?? []).map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.label}
                            {c.remoteUrl ? ` · ${c.remoteUrl}` : ""}
                            {` · ${c.localPath}`}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : (
                    <>
                      <label>
                        Remote URL (optional)
                        <input
                          data-testid="settings-connect-url"
                          placeholder="https://github.com/you/boards.git"
                          value={connectUrl}
                          onChange={(e) => setConnectUrl(e.target.value)}
                        />
                      </label>
                      <label>
                        Local path (optional if cloning URL)
                        <input
                          data-testid="settings-connect-path"
                          placeholder="/path/to/boards"
                          value={connectPath}
                          onChange={(e) => setConnectPath(e.target.value)}
                        />
                      </label>
                      <label>
                        PAT for this repo (optional)
                        <input
                          type="password"
                          data-testid="settings-connect-token"
                          value={connectToken}
                          onChange={(e) => setConnectToken(e.target.value)}
                        />
                      </label>
                    </>
                  )}

                  <button
                    type="button"
                    className="kb-toolbar-btn"
                    data-testid="settings-new-board-submit"
                    disabled={
                      !newBoardName.trim() ||
                      busy ||
                      (!newBoardUseNewRepo && !newBoardRemote) ||
                      (newBoardUseNewRepo &&
                        !connectUrl.trim() &&
                        !connectPath.trim())
                    }
                    onClick={() => {
                      void onCreateBoard(newBoardName.trim(), {
                        credentialId: newBoardCred || null,
                        remoteSlug: newBoardUseNewRepo
                          ? undefined
                          : newBoardRemote || undefined,
                        boardDir: newBoardDir.trim() || undefined,
                      }).then(() => {
                        setNewBoardName("");
                        setNewBoardDir("");
                        setNewBoardCred("");
                        setShowAddBoard(false);
                        setNewBoardUseNewRepo(false);
                      });
                    }}
                  >
                    Create board
                  </button>
                </div>
              ) : null}

              <ul className="kb-disclose-list" data-testid="settings-board-list">
                {(workspace?.boards ?? []).map((b) => {
                  const open = expandedBoardKey === b.key;
                  const draft =
                    editBoardDraft?.key === b.key ? editBoardDraft : null;
                  return (
                    <li key={b.key} className={open ? "is-open" : undefined}>
                      <button
                        type="button"
                        className="kb-disclose-row"
                        data-testid={`settings-board-row-${b.boardId}`}
                        aria-expanded={open}
                        onClick={() => {
                          if (open) {
                            setExpandedBoardKey(null);
                            setEditBoardDraft(null);
                          } else {
                            openBoardEditor(b);
                          }
                        }}
                      >
                        <span className="kb-disclose-row-main">
                          <strong>{b.label || b.boardId}</strong>
                          <span className="kb-muted">
                            dir <code>{b.boardDir}</code>
                            {" · "}
                            {b.remoteUrl
                              ? b.remoteUrl.replace(/^https?:\/\//, "")
                              : b.localPath}
                            {" · "}
                            {b.cardCount} cards
                            {b.resolvedCredentialId
                              ? ` · cred ${b.resolvedCredentialId}`
                              : " · no named cred"}
                          </span>
                        </span>
                        <span className="kb-disclose-chevron" aria-hidden>
                          {open ? "▾" : "▸"}
                        </span>
                      </button>
                      {open && draft ? (
                        <div
                          className="kb-disclose"
                          data-testid={`settings-board-detail-${b.boardId}`}
                        >
                          <p className="kb-disclose-step">
                            <span className="kb-disclose-step-n">1</span>{" "}
                            Credentials
                          </p>
                          <label>
                            Credential for this board
                            <select
                              value={draft.credentialId}
                              data-testid={`settings-board-cred-${b.boardId}`}
                              onChange={(e) =>
                                setEditBoardDraft({
                                  ...draft,
                                  credentialId: e.target.value,
                                })
                              }
                            >
                              <option value="">
                                Connection default
                                {b.connectionDefaultCredentialId
                                  ? ` (${b.connectionDefaultCredentialId})`
                                  : " / SSH agent / none"}
                              </option>
                              {(workspace?.credentials ?? []).map((c) => (
                                <option key={c.id} value={c.id}>
                                  {c.label}
                                </option>
                              ))}
                            </select>
                          </label>

                          <p className="kb-disclose-step">
                            <span className="kb-disclose-step-n">2</span>{" "}
                            Repository (connection)
                          </p>
                          <label>
                            Connected repository
                            <select
                              value={draft.remoteSlug}
                              data-testid={`settings-board-remote-${b.boardId}`}
                              onChange={(e) =>
                                setEditBoardDraft({
                                  ...draft,
                                  remoteSlug: e.target.value,
                                })
                              }
                            >
                              {(workspace?.connections ?? []).map((c) => (
                                <option key={c.id} value={c.id}>
                                  {c.label}
                                  {c.remoteUrl ? ` · ${c.remoteUrl}` : ""}
                                  {` @ ${c.localPath}`}
                                </option>
                              ))}
                            </select>
                          </label>
                          <div className="kb-disclose-grid">
                            <div>
                              <span className="kb-disclose-k">Sync remote</span>
                              <code className="kb-disclose-v">
                                {b.remoteUrl ?? "— local only (no origin) —"}
                              </code>
                            </div>
                            <div>
                              <span className="kb-disclose-k">Local clone</span>
                              <code className="kb-disclose-v">{b.localPath}</code>
                            </div>
                            <div>
                              <span className="kb-disclose-k">HEAD</span>
                              <code className="kb-disclose-v">
                                {b.sha.slice(0, 7)}
                              </code>
                            </div>
                          </div>
                          <p className="kb-muted">
                            To attach a different git remote URL, use{" "}
                            <strong>Repositories</strong> below (or add a new
                            connection), then select it here. Board files live
                            under the chosen clone.
                          </p>

                          <p className="kb-disclose-step">
                            <span className="kb-disclose-step-n">3</span>{" "}
                            Directory &amp; label
                          </p>
                          <label>
                            Display name
                            <input
                              value={draft.label}
                              onChange={(e) =>
                                setEditBoardDraft({
                                  ...draft,
                                  label: e.target.value,
                                })
                              }
                              data-testid={`settings-board-label-${b.boardId}`}
                            />
                          </label>
                          <label>
                            Board directory (in repo)
                            <input
                              value={draft.boardDir}
                              onChange={(e) =>
                                setEditBoardDraft({
                                  ...draft,
                                  boardDir: e.target.value,
                                })
                              }
                              data-testid={`settings-board-dir-${b.boardId}`}
                            />
                          </label>
                          <span className="kb-muted">
                            Directory is the layout-A folder id (e.g.{" "}
                            <code>backend</code>). Changing this only updates
                            the binding metadata — rename the folder in git
                            separately if you rename on disk.
                          </span>

                          <div className="kb-settings-actions">
                            <button
                              type="button"
                              className="kb-toolbar-btn"
                              data-testid={`settings-board-save-${b.boardId}`}
                              disabled={busy}
                              onClick={() => void saveBoardEditor()}
                            >
                              Save board config
                            </button>
                            <button
                              type="button"
                              className="kb-toolbar-btn"
                              onClick={() => {
                                if (
                                  b.remoteSlug !== workspace?.activeRemote
                                ) {
                                  void switchRemote(
                                    b.remoteSlug,
                                    b.boardId,
                                  ).then(() => setShowSettings(false));
                                } else {
                                  reload(b.boardId)
                                    .then(() => setShowSettings(false))
                                    .catch((e) => setError(String(e)));
                                }
                              }}
                            >
                              Open board
                            </button>
                            <button
                              type="button"
                              className="kb-toolbar-btn"
                              data-testid="pull-remote"
                              disabled={busy}
                              onClick={() => {
                                if (
                                  b.remoteSlug !== workspace?.activeRemote
                                ) {
                                  void switchRemote(
                                    b.remoteSlug,
                                    b.boardId,
                                  ).then(() => onPullRemote());
                                } else {
                                  void onPullRemote();
                                }
                              }}
                            >
                              Fetch / sync
                            </button>
                          </div>
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
              {(workspace?.boards.length ?? 0) === 0 ? (
                <p className="kb-muted">
                  No boards yet — use <strong>+ add board</strong> to create one
                  and attach a repository.
                </p>
              ) : null}
            </section>
            ) : null}

            {settingsNav === "repositories" ? (
            <section className="kb-settings-section" data-testid="settings-remotes">
              <div className="kb-settings-section-head">
                <h3 className="kb-settings-section-title">repositories</h3>
                <button
                  type="button"
                  className="kb-toolbar-btn"
                  data-testid="settings-add-connection-toggle"
                  onClick={() => setShowAddConnection((v) => !v)}
                >
                  {showAddConnection ? "cancel" : "+ add repository"}
                </button>
              </div>
              <p className="kb-muted">
                Git clones available for boards. Prefer configuring repo +
                credentials on each <strong>board</strong> above; manage shared
                clones and default credentials here.
              </p>

              {showAddConnection ? (
                <form
                  className="kb-disclose kb-connect-form"
                  data-testid="settings-add-connection"
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
                        setStatus(`Connected ${r.path}`);
                        if (r.slug) setRemoteSlug(r.slug);
                        if (r.remotes) setRemotes(r.remotes);
                        if (connectToken.trim()) {
                          try {
                            await upsertCredentialBook({
                              label:
                                connectUrl.trim() ||
                                connectPath.trim() ||
                                "GitHub PAT",
                              token: connectToken.trim(),
                            });
                          } catch {
                            /* optional */
                          }
                        }
                        setConnectToken("");
                        await reload(r.boards[0]?.id);
                        await refreshWorkspace();
                        setShowAddConnection(false);
                      })
                      .catch((err) => setError(String(err)))
                      .finally(() => setConnectBusy(false));
                  }}
                >
                  <label>
                    Remote URL
                    <input
                      placeholder="https://github.com/you/boards.git"
                      value={connectUrl}
                      onChange={(e) => setConnectUrl(e.target.value)}
                    />
                  </label>
                  <label>
                    Local path
                    <input
                      placeholder="/path/to/boards"
                      value={connectPath}
                      onChange={(e) => setConnectPath(e.target.value)}
                    />
                  </label>
                  <label>
                    PAT (optional)
                    <input
                      type="password"
                      value={connectToken}
                      onChange={(e) => setConnectToken(e.target.value)}
                    />
                  </label>
                  <button type="submit" disabled={connectBusy}>
                    {connectBusy ? "Connecting…" : "Connect repository"}
                  </button>
                </form>
              ) : null}

              <ul className="kb-disclose-list" data-testid="remote-sidebar">
                {(workspace?.connections ?? []).map((r) => {
                  const open = expandedConnectionId === r.id;
                  return (
                    <li key={r.id} className={open ? "is-open" : undefined}>
                      <button
                        type="button"
                        className="kb-disclose-row"
                        data-testid={`remote-${r.id}`}
                        aria-expanded={open}
                        onClick={() =>
                          setExpandedConnectionId(open ? null : r.id)
                        }
                      >
                        <span className="kb-disclose-row-main">
                          <strong>{r.label}</strong>
                          <span className="kb-muted">
                            {r.boardCount} board(s)
                            {r.remoteUrl ? ` · ${r.remoteUrl}` : ""}
                            {r.active ? " · active" : ""}
                          </span>
                        </span>
                        <span className="kb-disclose-chevron">
                          {open ? "▾" : "▸"}
                        </span>
                      </button>
                      {open ? (
                        <div className="kb-disclose">
                          <div className="kb-disclose-grid">
                            <div>
                              <span className="kb-disclose-k">Local path</span>
                              <code className="kb-disclose-v">{r.localPath}</code>
                            </div>
                            <div>
                              <span className="kb-disclose-k">Remote URL</span>
                              <code className="kb-disclose-v">
                                {r.remoteUrl ?? "— none —"}
                              </code>
                            </div>
                          </div>
                          <label>
                            Default credential for boards on this repo
                            <select
                              value={r.defaultCredentialId ?? ""}
                              onChange={(e) => {
                                const v = e.target.value;
                                void patchConnection({
                                  id: r.id,
                                  defaultCredentialId: v === "" ? null : v,
                                })
                                  .then(() => refreshWorkspace())
                                  .catch((err) => setError(String(err)));
                              }}
                            >
                              <option value="">None / SSH agent</option>
                              {(workspace?.credentials ?? []).map((c) => (
                                <option key={c.id} value={c.id}>
                                  {c.label}
                                </option>
                              ))}
                            </select>
                          </label>
                          <div className="kb-settings-actions">
                            <button
                              type="button"
                              className="kb-toolbar-btn"
                              disabled={r.active || busy}
                              onClick={() =>
                                void switchRemote(r.id).then(() =>
                                  refreshWorkspace(),
                                )
                              }
                            >
                              {r.active ? "active" : "set active"}
                            </button>
                          </div>
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </section>
            ) : null}

            {settingsNav === "credentials" ? (
            <section className="kb-settings-section" data-testid="settings-credentials">
              <div className="kb-settings-section-head">
                <h3 className="kb-settings-section-title">credentials</h3>
                <button
                  type="button"
                  className="kb-toolbar-btn"
                  data-testid="settings-add-cred-toggle"
                  onClick={() => setShowAddCredential((v) => !v)}
                >
                  {showAddCredential ? "cancel" : "+ add credential"}
                </button>
              </div>
              <p className="kb-muted">
                Named HTTPS PATs (encrypted under ~/.kanbanly/). Assign per
                board or as a connection default. SSH still uses your agent.
              </p>

              {showAddCredential ? (
                <div className="kb-disclose" data-testid="settings-add-cred">
                  <label>
                    Label
                    <input
                      value={newCredLabel}
                      onChange={(e) => setNewCredLabel(e.target.value)}
                      placeholder="Work GitHub"
                      data-testid="settings-cred-label"
                    />
                  </label>
                  <label>
                    Username
                    <input
                      value={newCredUser}
                      onChange={(e) => setNewCredUser(e.target.value)}
                      placeholder="x-access-token"
                    />
                  </label>
                  <label>
                    Token / PAT
                    <input
                      type="password"
                      value={newCredToken}
                      onChange={(e) => setNewCredToken(e.target.value)}
                      data-testid="settings-cred-token"
                    />
                  </label>
                  <button
                    type="button"
                    className="kb-toolbar-btn"
                    data-testid="settings-cred-submit"
                    disabled={!newCredLabel.trim() || !newCredToken.trim()}
                    onClick={() => {
                      void upsertCredentialBook({
                        label: newCredLabel.trim(),
                        username: newCredUser.trim() || "x-access-token",
                        token: newCredToken.trim(),
                      })
                        .then(() => {
                          setNewCredLabel("");
                          setNewCredToken("");
                          setShowAddCredential(false);
                          return refreshWorkspace();
                        })
                        .catch((e) => setError(String(e)));
                    }}
                  >
                    Save credential
                  </button>
                </div>
              ) : null}

              <ul className="kb-disclose-list">
                {(workspace?.credentials ?? []).map((c) => (
                  <li key={c.id}>
                    <div className="kb-disclose-row kb-disclose-row--static">
                      <span className="kb-disclose-row-main">
                        <strong>{c.label}</strong>
                        <span className="kb-muted">
                          {c.username} · {c.id} ·{" "}
                          {new Date(c.updatedAt).toLocaleString()}
                        </span>
                      </span>
                      <button
                        type="button"
                        className="kb-toolbar-btn"
                        data-testid={`settings-cred-delete-${c.id}`}
                        onClick={() => {
                          if (
                            window.confirm(
                              `Delete credential “${c.label}”? Boards using it fall back to connection default.`,
                            )
                          ) {
                            void deleteCredentialBook(c.id)
                              .then(() => refreshWorkspace())
                              .catch((e) => setError(String(e)));
                          }
                        }}
                      >
                        delete
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
              {(workspace?.credentials.length ?? 0) === 0 ? (
                <p className="kb-muted">No named credentials yet.</p>
              ) : null}
            </section>
            ) : null}

            {settingsNav === "filters" ? (
            <section className="kb-settings-section">
              <h3 className="kb-settings-section-title">filters</h3>
              <div className="kb-settings-filters">
                <label>
                  Label
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
                </label>
                <label>
                  Assignee
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
                </label>
              </div>
            </section>
            ) : null}

            {settingsNav === "theme" ? (
            <section className="kb-settings-section">
              <h3 className="kb-settings-section-title">theme</h3>
              <div className="kb-theme-switch" role="group" aria-label="Theme">
                {(
                  [
                    ["light", "light"],
                    ["dark", "dark"],
                    ["system", "auto"],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={themePref === value}
                    onClick={() => setThemePref(value)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </section>
            ) : null}

            {settingsNav === "activity" ? (
            <section className="kb-settings-section" data-testid="settings-activity">
              <div className="kb-settings-section-head">
                <h3 className="kb-settings-section-title">activity</h3>
              </div>
              <p className="kb-muted">
                Recent card log entries from the open board.
              </p>
              <div
                className="kb-activity kb-activity--settings"
                data-testid="activity-feed"
              >
                {activity.length === 0 ? (
                  <p className="kb-empty">No log entries yet.</p>
                ) : (
                  <ul className="kb-activity-list">
                    {activity.map((e, i) => (
                      <li
                        key={`${e.cardId}-${e.date}-${i}`}
                        data-testid="activity-item"
                      >
                        <span className="kb-activity-date">{e.date}</span>
                        <button
                          type="button"
                          className="kb-activity-card"
                          data-testid={`activity-card-${e.cardId}`}
                          onClick={() => {
                            const c = board?.cards.find(
                              (x) => x.id === e.cardId,
                            );
                            if (c) {
                              setFocusedCardId(c.id);
                              setSelected(c);
                              setShowSettings(false);
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
              </div>
            </section>
            ) : null}
            </div>
          </div>
        </div>
      ) : null}

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
              <li>Drag a list header left/right to reorder lists</li>
            </ul>
          </div>
        </div>
      ) : null}
    </div>
  );
}
