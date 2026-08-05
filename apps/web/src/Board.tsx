import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
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
  isFilterActive,
  isInnermostDropTarget,
  keyToMoveDirection,
  keyToNavDirection,
  keyboardMoveTarget,
  navigateFocus,
  renderMarkdown,
  resolveDropIndex,
  staticPrStatus,
  checkDoingWip,
  formatPulseAge,
  isDoingColumn,
  type AppRoute,
  type CrossBoardActivityEntry,
  type DropEdge,
  type NavBoard,
  type SettingsSection,
} from "@kanbanly/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  subscribeBoardEvents,
  type ActivityEntry,
  type BoardCard,
  type BoardDetail,
  type CardHistoryEntry,
  type ChecklistItem,
  type PrStatusResponse,
  type ProjectCommit,
  type WorkspaceBoard,
  type WorkspaceConnection,
  type WorkspaceCredential,
} from "./api.ts";
import {
  boardQuery,
  boardsQuery,
  commitsByCardId,
  fleetHealthQuery,
  portfolioQuery,
  prRefsFromCards,
  qk,
  remotesQuery,
  syncQuery,
  useActivity,
  useAddColumn,
  useArchiveCards,
  useBindCodeSource,
  useBoard,
  useBoardNotes,
  useBoards,
  useCardHistory,
  useClearSyncFreeze,
  useCodeHistory,
  useConflicts,
  useConnectRepo,
  useCreateBoard,
  useCreateCard,
  useDeleteColumn,
  useDeleteCredentialBook,
  useFleetHealth,
  useInvalidators,
  useMoveCard,
  usePatchBoardBinding,
  usePatchConnection,
  usePortfolio,
  usePrStatuses,
  usePullRemote,
  usePutBoardNotes,
  useRemapColumn,
  useRenameColumn,
  useReorderColumns,
  useResolveConflict,
  useRetrySync,
  useSetActiveRemote,
  useSetCredentials,
  useSync,
  useUpdateCard,
  useUpsertCredentialBook,
  useWorkspace,
  credentialBookQuery,
  useRefreshRepo,
} from "./queries.ts";
import {
  legacySlugReplace,
  useAppRouteReader,
  useNavigateTo,
  usePopNavigation,
} from "./routes.tsx";
import {
  applyTheme,
  watchSystemTheme,
  readThemePreference,
  type ThemePreference,
} from "./theme.ts";
import {
  alertKey,
  pruneAcked,
  readAckedAlerts,
  writeAckedAlerts,
} from "./alerts.ts";
import { MarkdownEditor } from "./MarkdownEditor.tsx";
import { CardLog } from "./CardLog.tsx";
import {
  Chip,
  CountBadge,
  DueChip,
  LabelChip,
  PriorityChip,
} from "./ui/Chip.tsx";
import { IconButton, SegmentedControl, ToolbarButton } from "./ui/Button.tsx";
import { MenuItem, Popover } from "./ui/Popover.tsx";
import { EmptyState, Field, SectionTitle } from "./ui/Field.tsx";
import { DataTable, type DataTableColumn } from "./ui/DataTable.tsx";
import { AssigneeChip, Avatar, Dot } from "./ui/Avatar.tsx";
import { ProgressBar, SegmentBar } from "./ui/Progress.tsx";
import {
  columnAccent,
  columnAccents,
  labelColor,
  paletteFor,
} from "./ui/palette.ts";

/** Column id → display name ("in-review" → "In Review"). */
function columnLabel(id: string): string {
  return id
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

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
              <LabelChip key={l} label={l} color={labelColor(l)} />
            ))}
          </div>
        ) : null}
        <div className="kb-card-title">{card.title}</div>
        {card.checklist && card.checklist.length > 0 ? (
          <ProgressBar
            done={card.checklist.filter((i) => i.done).length}
            total={card.checklist.length}
            testId={`checklist-${card.id}`}
          />
        ) : null}
        <div className="kb-card-meta">
          {card.priority ? (
            <PriorityChip
              priority={card.priority}
              data-testid={`priority-${card.id}`}
            />
          ) : null}
          {card.due ? (
            <DueChip due={card.due} data-testid={`due-${card.id}`} />
          ) : null}
          <Chip base="kb-card-id" title={card.id}>
            {card.id}
          </Chip>
          <span className="kb-card-meta-spacer" aria-hidden="true" />
          {card.assignee ? <AssigneeChip name={card.assignee} /> : null}
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
      <ToolbarButton
        data-testid="create-board-open"
        onClick={() => setOpen(true)}
        disabled={busy}
        title="Create a new board (layout A subdirectory)"
      >
        + Board
      </ToolbarButton>
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
      <ToolbarButton
        data-testid="create-board-submit"
        disabled={!name.trim() || saving || busy}
        onClick={() => void submit()}
      >
        {saving ? "…" : "Create"}
      </ToolbarButton>
      <ToolbarButton
        data-testid="create-board-cancel"
        onClick={() => {
          setOpen(false);
          setName("");
        }}
      >
        Cancel
      </ToolbarButton>
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
  accent,
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
  /** Board-resolved accent; falls back to a hash when not supplied. */
  accent?: string;
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

  const colAccent = accent ?? columnAccent(columnId);

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
          <CountBadge
            className="kb-column-count"
            value={cards.length}
            data-testid={`count-${columnId}`}
            aria-label={`${cards.length} cards`}
          />
          {onRenameColumn || onMoveColumn || onDeleteColumn ? (
            // No `onClose`: this menu has never dismissed on an outside click
            // or Escape, and adding either here would be a behaviour change.
            <Popover
              open={menuOpen}
              className="kb-col-menu-wrap"
              panelClassName="kb-col-menu"
              panelTestId={`col-menu-panel-${columnId}`}
              role="menu"
              anchor={
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
              }
            >
              {onRenameColumn ? (
                <MenuItem
                  role="menuitem"
                  testId={`col-rename-${columnId}`}
                  onClick={() => {
                    setMenuOpen(false);
                    setRenameValue(columnName);
                    setRenaming(true);
                  }}
                >
                  Rename list
                </MenuItem>
              ) : null}
              {onMoveColumn && canMoveLeft ? (
                <MenuItem
                  role="menuitem"
                  testId={`col-move-left-${columnId}`}
                  onClick={() => {
                    setMenuOpen(false);
                    void onMoveColumn(columnId, -1);
                  }}
                >
                  Move left
                </MenuItem>
              ) : null}
              {onMoveColumn && canMoveRight ? (
                <MenuItem
                  role="menuitem"
                  testId={`col-move-right-${columnId}`}
                  onClick={() => {
                    setMenuOpen(false);
                    void onMoveColumn(columnId, 1);
                  }}
                >
                  Move right
                </MenuItem>
              ) : null}
              {onDeleteColumn ? (
                <MenuItem
                  role="menuitem"
                  className="kb-col-menu-danger"
                  testId={`col-delete-${columnId}`}
                  onClick={() => {
                    setDeleteOpen(true);
                    const first = otherColumns?.[0]?.id ?? "archive";
                    setDeleteMoveTo(cards.length > 0 ? first : "");
                  }}
                >
                  Delete list…
                </MenuItem>
              ) : null}
              {deleteOpen && onDeleteColumn ? (
                <div className="kb-col-delete" data-testid={`col-delete-panel-${columnId}`}>
                  {cards.length > 0 ? (
                    <>
                      <EmptyState>
                        {cards.length} card{cards.length === 1 ? "" : "s"} — move to:
                      </EmptyState>
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
                    <EmptyState>Delete empty list?</EmptyState>
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
            </Popover>
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
          <EmptyState tone="empty" as="div" testId={`empty-${columnId}`}>
            Empty
          </EmptyState>
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

/**
 * Every commit log in the app renders the same three stacked cells — sha,
 * subject, "author · date" — and shares these sort keys.
 *
 * `author` is a column even though it never gets a cell of its own: it lives
 * inside the byline, so hiding it is what lets you sort and search by author
 * without splitting the byline into two elements and changing the markup.
 */
const COMMIT_HIDDEN_COLUMNS = ["author"] as const;

/** Shared by all three commit lists: the byline cell plus the author sort key. */
function commitBylineColumns<
  T extends { date: string; author: string },
>(): DataTableColumn<T>[] {
  return [
    {
      id: "date",
      header: "date",
      accessorFn: (c) => c.date,
      // Newest-first is what you want from a log; ascending is the odd case.
      sortDescFirst: true,
      cell: (ctx) => (
        <span className="kb-muted">
          {ctx.row.original.author} · {ctx.row.original.date.slice(0, 10)}
        </span>
      ),
    },
    { id: "author", header: "author", accessorFn: (c) => c.author },
  ];
}

/** Boards-repo log for one card's markdown file. Shas have nowhere to link. */
const CARD_HISTORY_COLUMNS: DataTableColumn<CardHistoryEntry>[] = [
  {
    id: "sha",
    accessorFn: (h) => h.sha,
    cell: (ctx) => (
      <code className="kb-history-sha">{ctx.row.original.sha.slice(0, 7)}</code>
    ),
  },
  {
    id: "subject",
    header: "subject",
    accessorFn: (h) => h.subject,
    cell: (ctx) => (
      <span className="kb-history-subj">{ctx.row.original.subject}</span>
    ),
  },
  ...commitBylineColumns<CardHistoryEntry>(),
];

/** Source-repo commits naming this card. These shas link out to the forge. */
const CODE_COMMIT_COLUMNS: DataTableColumn<ProjectCommit>[] = [
  {
    id: "sha",
    accessorFn: (c) => c.sha,
    cell: (ctx) => {
      const c = ctx.row.original;
      return c.url ? (
        <a
          className="kb-history-sha kb-linkish"
          href={c.url}
          target="_blank"
          rel="noreferrer noopener"
          title={c.sha}
        >
          {c.sha.slice(0, 7)}
        </a>
      ) : (
        <code className="kb-history-sha" title={c.sha}>
          {c.sha.slice(0, 7)}
        </code>
      );
    },
  },
  {
    id: "subject",
    header: "subject",
    accessorFn: (c) => c.subject,
    cell: (ctx) => (
      <span className="kb-history-subj">{ctx.row.original.subject}</span>
    ),
  },
  ...commitBylineColumns<ProjectCommit>(),
];

function DetailPanel({
  card,
  boardId,
  accent,
  commits,
  onClose,
  onSave,
  busy,
}: {
  card: BoardCard;
  boardId: string;
  /** Board-resolved column accent for the modal stripe. */
  accent?: string;
  /** Source-repo commits whose subject names this card id. */
  commits?: ProjectCommit[];
  onClose: () => void;
  onSave: (patch: {
    title?: string;
    status?: string;
    assignee?: string | null;
    due?: string | null;
    labels?: string[];
    priority?: string | null;
    checklist?: ChecklistItem[];
  }) => Promise<void>;
  busy: boolean;
}) {
  const [title, setTitle] = useState(card.title);
  const [status, setStatusText] = useState(card.status ?? "");
  const [checklist, setChecklist] = useState<ChecklistItem[]>(
    card.checklist ?? [],
  );
  const [checkDraft, setCheckDraft] = useState("");
  const [assignee, setAssignee] = useState(card.assignee ?? "");
  const [due, setDue] = useState(card.due ?? "");
  const [priority, setPriority] = useState(card.priority ?? "");
  const [labels, setLabels] = useState((card.labels ?? []).join(", "));
  const [editStatus, setEditStatus] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);

  // Boards-repo log for this card's file. Keyed on the ids, not the card
  // object, so a background board refetch does not re-request it.
  const historyQuery = useCardHistory(boardId, card.id);
  const history = historyQuery.data?.entries ?? [];
  // A failed read is indistinguishable from an empty log here, exactly as the
  // hand-rolled `.catch(() => setHistory([]))` it replaces.
  const historyLoading = historyQuery.isPending;

  useEffect(() => {
    setTitle(card.title);
    setStatusText(card.status ?? "");
    setAssignee(card.assignee ?? "");
    setDue(card.due ?? "");
    setPriority(card.priority ?? "");
    setLabels((card.labels ?? []).join(", "));
    setChecklist(card.checklist ?? []);
    setCheckDraft("");
    setEditStatus(false);
  }, [card]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const statusHtml = useMemo(() => renderMarkdown(status), [status]);

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
        className="kb-card-modal-dialog kb-card-modal-dialog--striped"
        data-testid="card-detail"
        data-card-id={card.id}
        role="dialog"
        aria-modal="true"
        aria-labelledby="kb-card-modal-title"
        style={{ ["--col-accent" as string]: accent ?? columnAccent(card.column) }}
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
            <Field
              label="Status"
              action={
                <button
                  type="button"
                  className="kb-linkish"
                  data-testid="detail-status-toggle"
                  onClick={() => setEditStatus((v) => !v)}
                >
                  {editStatus ? "Preview" : "Edit"}
                </button>
              }
            >
              {editStatus ? (
                <MarkdownEditor
                  testId="detail-status"
                  rows={8}
                  value={status}
                  onChange={setStatusText}
                  placeholder="Describe the work… **bold**, `code`, - lists"
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
            </Field>
            <Field
              as="div"
              testId="detail-checklist"
              label="Checklist"
              count={
                <>
                  {checklist.filter((i) => i.done).length}/{checklist.length}
                </>
              }
            >
              {checklist.length > 0 ? (
                <ul className="kb-checklist">
                  {checklist.map((item, idx) => (
                    <li key={`${item.text}-${idx}`} className="kb-checklist-item">
                      <label className="kb-checklist-label">
                        <input
                          type="checkbox"
                          checked={item.done}
                          data-testid={`checklist-toggle-${idx}`}
                          onChange={() =>
                            setChecklist((prev) =>
                              prev.map((x, j) =>
                                j === idx ? { ...x, done: !x.done } : x,
                              ),
                            )
                          }
                        />
                        <span className={item.done ? "is-done" : undefined}>
                          {item.text}
                        </span>
                      </label>
                      <button
                        type="button"
                        className="kb-checklist-remove"
                        aria-label={`Remove ${item.text}`}
                        title="Remove"
                        onClick={() =>
                          setChecklist((prev) => prev.filter((_, j) => j !== idx))
                        }
                      >
                        ✕
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
              <div className="kb-checklist-add">
                <input
                  data-testid="checklist-new"
                  value={checkDraft}
                  placeholder="Add an item…"
                  onChange={(e) => setCheckDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key !== "Enter") return;
                    e.preventDefault();
                    const text = checkDraft.trim();
                    if (!text) return;
                    setChecklist((prev) => [...prev, { text, done: false }]);
                    setCheckDraft("");
                  }}
                />
                <button
                  type="button"
                  data-testid="checklist-add"
                  onClick={() => {
                    const text = checkDraft.trim();
                    if (!text) return;
                    setChecklist((prev) => [...prev, { text, done: false }]);
                    setCheckDraft("");
                  }}
                >
                  add
                </button>
              </div>
            </Field>
            <Field as="div" testId="detail-log" label="Log">
              <CardLog lines={card.log} actorColor={paletteFor} />
            </Field>
            <Field as="div" testId="detail-history" label="Git history">
              {historyLoading ? (
                <EmptyState>Loading…</EmptyState>
              ) : history.length === 0 ? (
                <EmptyState>No commits yet.</EmptyState>
              ) : (
                <DataTable
                  data={history}
                  columns={CARD_HISTORY_COLUMNS}
                  listClassName="kb-history-list"
                  getRowId={(h) => h.sha}
                  rowTestId="history-entry"
                  hiddenColumns={COMMIT_HIDDEN_COLUMNS}
                  sortLabel="Sort card history"
                />
              )}
            </Field>
            {/* Source-repo commits naming this card id. Distinct from "Git
                history" above, which is the boards repo log for the card file. */}
            {commits && commits.length > 0 ? (
              <Field
                as="div"
                testId="detail-code-commits"
                label="Code commits"
                count={commits.length}
              >
                <DataTable
                  data={commits}
                  columns={CODE_COMMIT_COLUMNS}
                  listClassName="kb-history-list"
                  getRowId={(c) => c.sha}
                  rowTestId="code-commit-entry"
                  hiddenColumns={COMMIT_HIDDEN_COLUMNS}
                  sortLabel="Sort code commits"
                />
              </Field>
            ) : null}
          </div>

          <aside className="kb-card-modal-side">
            <Field label="Assignee">
              <input
                data-testid="detail-assignee"
                value={assignee}
                onChange={(e) => setAssignee(e.target.value)}
              />
            </Field>
            <Field label="Due">
              <input
                data-testid="detail-due"
                value={due}
                onChange={(e) => setDue(e.target.value)}
                placeholder="YYYY-MM-DD"
              />
            </Field>
            <Field label="Priority">
              <input
                data-testid="detail-priority"
                value={priority}
                onChange={(e) => setPriority(e.target.value)}
                placeholder="P1"
              />
            </Field>
            <Field label="Labels">
              <input
                data-testid="detail-labels"
                value={labels}
                onChange={(e) => setLabels(e.target.value)}
                placeholder="comma-separated"
              />
            </Field>
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
                  checklist,
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

/** Card-modal commit join: deep enough to cover a card's whole life. */
const CARD_COMMIT_LIMIT = 200;
/** Project-history modal: the api default, kept explicit so it can be a key. */
const PROJECT_HISTORY_LIMIT = 50;
/** Activity feed page size (overrides both the api and server defaults). */
const ACTIVITY_LIMIT = 80;
/** Portfolio home shows a short digest; the server already caps the feed at 40. */
const PORTFOLIO_ACTIVITY_LIMIT = 20;

const NO_PR_STATUSES: Record<string, PrStatusResponse | null> = {};

/** `String(e)` for a query error, `null` when the query is healthy. */
function errorText(e: unknown): string | null {
  return e == null ? null : String(e);
}

/*
 * Settings' three disclosure lists are the one place where the table's columns
 * are pure sort and filter keys: a row there is a single expandable <button>
 * plus a form, not a stack of cells, so `renderRow` keeps the markup and these
 * defs stay free of cell renderers. They close over nothing, so they live at
 * module scope and never churn the row model.
 *
 * A column earns a `header` when sorting by it is meaningful. The rest —
 * credential ids, remote URLs — exist so the search box can find a board by
 * them, which is how you locate one board among twenty.
 */
const WORKSPACE_BOARD_COLUMNS: DataTableColumn<WorkspaceBoard>[] = [
  { id: "name", header: "name", accessorFn: (b) => b.label || b.boardId },
  {
    id: "cards",
    header: "cards",
    accessorFn: (b) => b.cardCount,
    sortDescFirst: true,
  },
  { id: "dir", header: "dir", accessorFn: (b) => b.boardDir },
  { id: "repo", header: "repo", accessorFn: (b) => b.remoteUrl ?? b.localPath },
  { id: "credential", accessorFn: (b) => b.resolvedCredentialId ?? "" },
];

const WORKSPACE_CONNECTION_COLUMNS: DataTableColumn<WorkspaceConnection>[] = [
  { id: "label", header: "label", accessorFn: (r) => r.label },
  {
    id: "boards",
    header: "boards",
    accessorFn: (r) => r.boardCount,
    sortDescFirst: true,
  },
  { id: "remote", accessorFn: (r) => r.remoteUrl ?? r.localPath },
];

const WORKSPACE_CREDENTIAL_COLUMNS: DataTableColumn<WorkspaceCredential>[] = [
  { id: "label", header: "label", accessorFn: (c) => c.label },
  { id: "username", header: "username", accessorFn: (c) => c.username },
  {
    id: "updated",
    header: "updated",
    accessorFn: (c) => c.updatedAt,
    sortDescFirst: true,
  },
  { id: "id", accessorFn: (c) => c.id },
];

export function BoardApp() {
  const queryClient = useQueryClient();
  const inv = useInvalidators();
  /**
   * Routing. `readAppRoute` parses the router's location with packages/core's
   * `parseAppRoute`; `navigateTo` writes `formatAppPath`'s string back through
   * the router's history. Both are imperative on purpose — the app tracks the
   * route in its own state, so subscribing to the location here would re-render
   * the whole tree on every self-issued URL sync. See routes.tsx.
   */
  const readAppRoute = useAppRouteReader();
  const navigateTo = useNavigateTo();

  const [boardId, setBoardId] = useState<string | null>(null);
  /**
   * Errors this component raises itself (mutations, deep-link misses). Query
   * failures are folded in below rather than copied into state, so a successful
   * refetch clears them without anyone remembering to.
   */
  const [localError, setLocalError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string>("");
  const [selected, setSelected] = useState<BoardCard | null>(null);
  const [filterQuery, setFilterQuery] = useState("");
  const [filterLabel, setFilterLabel] = useState("");
  const [filterAssignee, setFilterAssignee] = useState("");
  const [filterPriority, setFilterPriority] = useState("");
  const [themePref, setThemePref] = useState<ThemePreference>(() =>
    typeof document !== "undefined" ? readThemePreference() : "system",
  );
  const [showNotes, setShowNotes] = useState(false);
  /** `null` means "show whatever the server last handed us". */
  const [notesDraft, setNotesDraft] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [codePathDraft, setCodePathDraft] = useState<string | null>(null);
  const [codeRemoteDraft, setCodeRemoteDraft] = useState<string | null>(null);
  const [codeCredentialDraft, setCodeCredentialDraft] = useState<string | null>(null);
  const [codeWatchDraft, setCodeWatchDraft] = useState<boolean | null>(null);
  const [codeTokenDraft, setCodeTokenDraft] = useState("");
  const [showPortfolio, setShowPortfolio] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showAlerts, setShowAlerts] = useState(false);
  const [ackedAlerts, setAckedAlerts] = useState<Set<string>>(readAckedAlerts);
  const [settingsNav, setSettingsNav] = useState<SettingsSection>("boards");
  const [boardMenuOpen, setBoardMenuOpen] = useState(false);
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
  const [credToken, setCredToken] = useState("");
  const [credUser, setCredUser] = useState("x-access-token");
  const [connectUrl, setConnectUrl] = useState("");
  const [connectPath, setConnectPath] = useState("");
  const [connectToken, setConnectToken] = useState("");
  /**
   * Card the URL asked for before its board had loaded. A ref, not state: it is
   * only ever written just before a reload and read inside it, and as state it
   * would churn `reload`'s identity for every consumer downstream.
   */
  const pendingCardIdRef = useRef<string | null>(null);
  const [remoteSlug, setRemoteSlug] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [showHelp, setShowHelp] = useState(false);

  // ---- reads -------------------------------------------------------------

  const boardsQ = useBoards();
  const boards = boardsQ.data?.boards ?? [];
  /** Only a *successful* empty list means "no repo"; a pending one means "wait". */
  const needsConnect = boardsQ.isSuccess && boards.length === 0;

  const boardQ = useBoard(boardId);
  // A failed board read blanks the grid, the way the old `setBoard(null)` in
  // reload's catch did — otherwise the error page would render over stale cards.
  const board = boardId && !boardQ.isError ? (boardQ.data ?? null) : null;

  // Note there is no remotes observer: nothing renders that list (the settings
  // pane reads connections off the workspace snapshot), so `reload` fetches it
  // straight into the cache in route order to pick up the active clone.

  const syncQ = useSync();
  const sync = syncQ.data ?? null;

  // Portfolio and fleet stay bound to the Projects screen, but their data
  // survives navigating away — which is what keeps the alert bell populated on
  // a board view after the portfolio has been visited once.
  const portfolioQ = usePortfolio(showPortfolio);
  const portfolio = portfolioQ.data ?? null;
  const fleetQ = useFleetHealth(showPortfolio);
  const fleet = fleetQ.data ?? null;

  const frozen = Boolean(
    sync?.frozen || sync?.errorKind === "conflict" || sync?.status === "frozen",
  );
  const conflictsQ = useConflicts(frozen);
  const conflicts = conflictsQ.data?.conflicts ?? [];

  const workspaceQ = useWorkspace(showSettings);
  const workspace = workspaceQ.data ?? null;
  // Hoisted so the `?? []` fallback keeps one identity across renders — a fresh
  // empty array on every pass would rebuild each settings table's row model.
  const workspaceBoards = useMemo(
    () => workspace?.boards ?? [],
    [workspace?.boards],
  );
  const workspaceConnections = useMemo(
    () => workspace?.connections ?? [],
    [workspace?.connections],
  );
  const workspaceCredentials = useMemo(
    () => workspace?.credentials ?? [],
    [workspace?.credentials],
  );

  const showActivity = showSettings && settingsNav === "activity";
  const activityQ = useActivity(boardId, ACTIVITY_LIMIT, showActivity);
  const activity = activityQ.data?.entries ?? [];

  // Keyed on the ref list itself: a board refetch that changes nothing about
  // the PRs neither restarts the 60s poll nor fires a request.
  const prRefs = useMemo(() => prRefsFromCards(board?.cards), [board?.cards]);
  const prStatusesQ = usePrStatuses(prRefs);
  const prStatuses = prStatusesQ.data ?? NO_PR_STATUSES;

  const notesQ = useBoardNotes(boardId, showNotes);
  const notesBody = notesDraft ?? notesQ.data?.body ?? "";

  const projectHistoryQ = useCodeHistory(
    boardId,
    PROJECT_HISTORY_LIMIT,
    showHistory,
  );
  const projectHistory = projectHistoryQ.data ?? null;
  const historyCommits = projectHistory?.commits ?? [];
  const codePath =
    codePathDraft ?? projectHistory?.binding?.path ?? projectHistory?.codePath ?? "";
  const codeRemote = codeRemoteDraft ?? projectHistory?.binding?.remote ?? "";
  const codeCredentialId =
    codeCredentialDraft ?? projectHistory?.binding?.credentialId ?? "";
  const codeWatch = codeWatchDraft ?? projectHistory?.binding?.watch ?? false;

  /**
   * The whole app's error line. Query failures are read, not copied: a
   * successful refetch clears them on its own. The panel-scoped reads only
   * report while their panel is on screen, so a stale failure cannot keep the
   * banner up after the modal that caused it has been closed.
   */
  const error =
    localError ??
    errorText(boardQ.error) ??
    errorText(boardsQ.error) ??
    (showActivity ? errorText(activityQ.error) : null) ??
    (showHistory ? errorText(projectHistoryQ.error) : null);

  // ---- writes ------------------------------------------------------------
  // `mutateAsync` is bound once by the observer, so these are stable across
  // renders and safe to name as callback dependencies.

  const { mutateAsync: moveCardAsync } = useMoveCard();
  const { mutateAsync: createCardAsync } = useCreateCard();
  const { mutateAsync: addColumnAsync } = useAddColumn();
  const { mutateAsync: renameColumnAsync } = useRenameColumn();
  const { mutateAsync: reorderColumnsAsync } = useReorderColumns();
  const { mutateAsync: deleteColumnAsync } = useDeleteColumn();
  const { mutateAsync: updateCardAsync } = useUpdateCard();
  const { mutateAsync: archiveCardsAsync } = useArchiveCards();
  const { mutateAsync: remapColumnAsync } = useRemapColumn();
  const { mutateAsync: pullRemoteAsync } = usePullRemote();
  const { mutateAsync: retrySyncAsync } = useRetrySync();
  const { mutateAsync: clearSyncFreezeAsync } = useClearSyncFreeze();
  const { mutateAsync: resolveConflictAsync } = useResolveConflict();
  const { mutateAsync: setCredentialsAsync, isPending: credBusy } =
    useSetCredentials();
  const { mutateAsync: connectRepoAsync, isPending: connectBusy } =
    useConnectRepo();
  const { mutateAsync: createBoardAsync } = useCreateBoard();
  const { mutateAsync: patchBoardBindingAsync } = usePatchBoardBinding();
  const { mutateAsync: patchConnectionAsync } = usePatchConnection();
  const { mutateAsync: upsertCredentialAsync } = useUpsertCredentialBook();
  const { mutateAsync: deleteCredentialAsync } = useDeleteCredentialBook();
  const { mutateAsync: setActiveRemoteAsync } = useSetActiveRemote();
  const { mutateAsync: putBoardNotesAsync, isPending: notesSaving } =
    usePutBoardNotes();
  const { mutateAsync: bindCodeSourceAsync, isPending: bindingCodeSource } =
    useBindCodeSource();
  const { mutate: refreshNow, isPending: refreshing } = useRefreshRepo();

  // Saved credentials, so a board can point at one instead of re-pasting a PAT.
  const credentialBookQ = useQuery({
    ...credentialBookQuery(),
    enabled: showHistory,
  });
  const credentialBook = credentialBookQ.data?.credentials ?? [];

  const notesBusy = notesQ.isFetching || notesSaving;
  const historyBusy =
    (showHistory && (projectHistoryQ.isPending || projectHistoryQ.isFetching)) ||
    bindingCodeSource;

  /**
   * Apply the URL to component state, then pull every read the new view needs.
   *
   * This is deliberately still imperative. It is not a data fetch — it is the
   * router: it decides which board is open, whether Settings is showing and
   * which card a deep link wants, and those decisions have to happen in order.
   * The fetches go through `fetchQuery` so they land in the same cache the
   * components observe; nothing is fetched twice.
   */
  const reload = useCallback(
    async (id?: string) => {
      setLocalError(null);
      try {
        const r = await queryClient.fetchQuery({
          ...remotesQuery(),
          staleTime: 0,
        });
        if (r.active) setRemoteSlug(r.active);
      } catch {
        /* ignore when not connected */
      }
      const list = await queryClient.fetchQuery({
        ...boardsQuery(),
        staleTime: 0,
      });
      if (list.boards.length === 0) {
        setBoardId(null);
        await queryClient.fetchQuery({ ...syncQuery(), staleTime: 0 });
        return;
      }
      // Re-read the location rather than closing over it: `reload` is also the
      // SSE handler, and that call site is pinned to the mount-time closure.
      const route = readAppRoute();
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
          const detail = await queryClient.fetchQuery({
            ...boardQuery(target),
            staleTime: 0,
          });
          const wantCard = pendingCardIdRef.current ?? routeCardId;
          if (wantCard) {
            const found = detail.cards.find((c) => c.id === wantCard);
            if (found) {
              setSelected(found);
              setFocusedCardId(found.id);
            } else if (routeCardId) {
              setLocalError(`Card not found: ${routeCardId}`);
            }
            pendingCardIdRef.current = null;
          }
        } catch (e) {
          setLocalError(String(e));
        }
      } else {
        setShowPortfolio(true);
        try {
          await Promise.all([
            queryClient.fetchQuery({ ...portfolioQuery(), staleTime: 0 }),
            queryClient.fetchQuery({ ...fleetHealthQuery(), staleTime: 0 }),
          ]);
        } catch {
          // Supplementary screen: a failed roll-up leaves an empty grid rather
          // than replacing the whole app with an error page.
        }
      }
      await queryClient.fetchQuery({ ...syncQuery(), staleTime: 0 });
    },
    [boardId, queryClient, readAppRoute],
  );

  useEffect(() => {
    applyTheme(themePref);
  }, [themePref]);

  // US-32: when preference is system, follow OS live changes
  useEffect(() => {
    return watchSystemTheme(() => themePref);
  }, [themePref]);

  useEffect(() => {
    const r = readAppRoute();
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
      if (r.cardId) pendingCardIdRef.current = r.cardId;
      if (r.remoteSlug) setRemoteSlug(r.remoteSlug);
    }
    reload().catch((e) => setLocalError(String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep URL in sync: board/card OR settings sections. Always `replace`, so
  // switching boards, opening a card and changing settings section stay off the
  // history stack exactly as they did before the router landed.
  useEffect(() => {
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
      navigateTo(
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
    // Deliberate: with no board open (portfolio/home) the URL is left alone, so
    // closing Settings from the portfolio keeps the /settings/... path on screen.
    // `openPortfolio` is the only path that forces it back to "/".
    if (!boardId) return;
    navigateTo(
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
    navigateTo,
  ]);

  /**
   * Browser back/forward.
   *
   * `usePopNavigation` fires for BACK / FORWARD / GO only, which is the same
   * set the old `popstate` listener saw — the app's own URL writes all go
   * through `replace`, and `replaceState` never emitted popstate. The old
   * `hashchange` listener is gone with it: the only runtime hash change in the
   * app is the `#kb-main-board` skip link, which parses to home, falls through
   * to the pathname (nav.ts:280-284) and re-applies the route the app is
   * already showing.
   */
  usePopNavigation((r: AppRoute) => {
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
        await setActiveRemoteAsync(r.remoteSlug);
        setRemoteSlug(r.remoteSlug);
      }
    };
    void switchRemoteIfNeeded()
      .then(() => {
        if (r.boardId && r.boardId !== boardId) {
          if (r.cardId) pendingCardIdRef.current = r.cardId;
          return reload(r.boardId);
        }
        if (r.cardId && board) {
          const found = board.cards.find((c) => c.id === r.cardId);
          if (found) {
            setSelected(found);
            setFocusedCardId(found.id);
          } else {
            setLocalError(`Card not found: ${r.cardId}`);
          }
        } else if (!r.cardId) {
          setSelected(null);
        }
      })
      .catch((e) => setLocalError(String(e)));
  });

  // Browser online/offline — auto-drain push queue when back online
  useEffect(() => {
    const on = () => {
      setBrowserOnline(true);
      // Auto-drain pending remote pushes on reconnect
      retrySyncAsync()
        .then((s) => {
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
  }, [retrySyncAsync]);

  /**
   * Live updates. The server pushes a `board` event whenever the repo sha
   * moves — from its own poll or from someone else's write — and every
   * board-derived read is stale at that moment.
   *
   * This used to call `reload()` from a `deps: []` effect, which pinned it to
   * the first-render closure and silently reset state the user had since
   * changed. Invalidation has no closure to go stale: `inv` is memoised on the
   * query client, so the subscription is opened once and stays correct.
   */
  useEffect(() => {
    let lastSha = "";
    return subscribeBoardEvents((ev) => {
      if (ev.reason === "hello") {
        lastSha = ev.sha;
        return;
      }
      if (ev.sha && ev.sha !== lastSha) {
        lastSha = ev.sha;
        setStatus(ev.reason === "poll" ? "Updated from git…" : "Board updated");
        void inv.live();
      }
    });
  }, [inv]);

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

      // Optimistic: paint the move at 0ms straight into the cache the grid
      // reads from. The mutation reconciles (or reverts) by invalidating.
      queryClient.setQueryData<BoardDetail>(qk.board(boardId), (prev) =>
        prev
          ? applyOptimisticMove(prev, cardId, payload.column, payload.order)
          : prev,
      );
      setStatus((s) =>
        s.startsWith("⚠") ? s : `Moved ${cardId} → ${toColumn}`,
      );
      setBusy(true);
      try {
        await moveCardAsync({ boardId, cardId, payload });
      } catch (e) {
        setLocalError(String(e));
        setStatus("Move failed");
      } finally {
        setBusy(false);
      }
    },
    [board, boardId, queryClient, moveCardAsync],
  );

  const createInColumn = useCallback(
    async (column: string, title: string) => {
      if (!boardId || !title.trim() || !board) return;
      setBusy(true);
      setLocalError(null);
      try {
        queryClient.setQueryData<BoardDetail>(qk.board(boardId), (prev) =>
          prev
            ? applyOptimisticCreate(prev, {
                id: `tmp-${Date.now()}`,
                title: title.trim(),
                column,
                order: "z",
                status: "_Not started._",
                labels: [],
              })
            : prev,
        );
        await createCardAsync({ boardId, title: title.trim(), column });
        setStatus(`Created in ${column}`);
      } catch (e) {
        setLocalError(String(e));
      } finally {
        setBusy(false);
      }
    },
    [boardId, board, queryClient, createCardAsync],
  );

  const onAddList = useCallback(
    async (name: string) => {
      if (!boardId) return;
      setBusy(true);
      setLocalError(null);
      try {
        const res = await addColumnAsync({ boardId, name });
        setStatus(`Added list “${res.column.name}”`);
      } catch (e) {
        setLocalError(String(e));
        throw e;
      } finally {
        setBusy(false);
      }
    },
    [boardId, addColumnAsync],
  );

  const onRenameList = useCallback(
    async (columnId: string, name: string) => {
      if (!boardId) return;
      setBusy(true);
      setLocalError(null);
      try {
        const res = await renameColumnAsync({ boardId, columnId, name });
        setStatus(`Renamed list to “${res.column.name}”`);
      } catch (e) {
        setLocalError(String(e));
        throw e;
      } finally {
        setBusy(false);
      }
    },
    [boardId, renameColumnAsync],
  );

  const applyColumnOrder = useCallback(
    async (next: string[]) => {
      if (!boardId) return;
      setBusy(true);
      setLocalError(null);
      try {
        // Optimistic local order for snappy UI
        queryClient.setQueryData<BoardDetail>(qk.board(boardId), (prev) => {
          if (!prev) return prev;
          const byId = new Map(prev.columns.map((c) => [c.id, c]));
          const columns = next
            .map((id) => byId.get(id))
            .filter((c): c is (typeof prev.columns)[number] => !!c);
          if (columns.length !== prev.columns.length) return prev;
          return { ...prev, columns };
        });
        // When the server echoes the authoritative order the mutation skips the
        // board refetch, so the optimistic columns below are not clobbered.
        const res = await reorderColumnsAsync({ boardId, order: next });
        setStatus("Reordered lists");
        if (res.columns?.length) {
          queryClient.setQueryData<BoardDetail>(qk.board(boardId), (prev) =>
            prev ? { ...prev, columns: res.columns } : prev,
          );
        }
      } catch (e) {
        setLocalError(String(e));
      } finally {
        setBusy(false);
      }
    },
    [boardId, queryClient, reorderColumnsAsync],
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
      setLocalError(null);
      try {
        const res = await deleteColumnAsync({ boardId, columnId, moveTo });
        const extra =
          res.archived && res.archived > 0
            ? ` (archived ${res.archived})`
            : res.moved && res.moved > 0
              ? ` (moved ${res.moved})`
              : "";
        setStatus(`Deleted list ${columnId}${extra}`);
      } catch (e) {
        setLocalError(String(e));
      } finally {
        setBusy(false);
      }
    },
    [boardId, deleteColumnAsync],
  );

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
      setLocalError(null);
      try {
        // Optional: connect a new repo first when creating a board against new path/url
        if (newBoardUseNewRepo && (connectUrl.trim() || connectPath.trim())) {
          const r = await connectRepoAsync({
            url: connectUrl.trim() || undefined,
            path: connectPath.trim() || undefined,
            token: connectToken.trim() || undefined,
            scaffold: true,
          });
          if (r.slug) setRemoteSlug(r.slug);
          if (connectToken.trim()) {
            try {
              await upsertCredentialAsync({
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

        // The mutation already refreshed the board list and the workspace, so
        // the only thing left is to open what was just created.
        const res = await createBoardAsync({
          name,
          options: {
            credentialId: opts?.credentialId,
            remoteSlug: opts?.remoteSlug,
            // boardDir is display-only for new boards; id is always random `b-…`
            // unless tests pass id explicitly via API.
          },
        });
        setStatus(`Created board “${res.boardId}”`);
        setBoardId(res.boardId);
        await reload(res.boardId);
      } catch (e) {
        setLocalError(String(e));
        throw e;
      } finally {
        setBusy(false);
      }
    },
    [
      reload,
      newBoardUseNewRepo,
      connectUrl,
      connectPath,
      connectToken,
      connectRepoAsync,
      createBoardAsync,
      upsertCredentialAsync,
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
    setLocalError(null);
    try {
      const fromRemoteSlug = editBoardDraft.key.split("::")[0]!;
      const editedBoardId = editBoardDraft.key.split("::")[1]!;
      await patchBoardBindingAsync({
        remoteSlug: editBoardDraft.remoteSlug,
        fromRemoteSlug,
        boardId: editedBoardId,
        credentialId:
          editBoardDraft.credentialId === ""
            ? null
            : editBoardDraft.credentialId,
        label: editBoardDraft.label.trim() || editedBoardId,
        boardDir: editBoardDraft.boardDir.trim() || editedBoardId,
      });
      setStatus(`Saved board “${editBoardDraft.label || editedBoardId}”`);
      // Keep editor open on new key if remote changed
      const newKey = `${editBoardDraft.remoteSlug}::${editedBoardId}`;
      setExpandedBoardKey(newKey);
      setEditBoardDraft({ ...editBoardDraft, key: newKey });
    } catch (e) {
      setLocalError(String(e));
    } finally {
      setBusy(false);
    }
  }, [editBoardDraft, patchBoardBindingAsync]);

  const highIssues = useMemo(
    () => (fleet?.issues ?? []).filter((i) => i.severity === "high"),
    [fleet],
  );
  /** Only unacknowledged alerts drive the badge. */
  const unackedAlerts = useMemo(
    () => highIssues.filter((i) => !ackedAlerts.has(alertKey(i))),
    [highIssues, ackedAlerts],
  );

  /**
   * Drop acknowledgements whose condition no longer exists, so the stored set
   * cannot grow without bound and a recurring alert is not permanently muted.
   */
  useEffect(() => {
    if (!fleet) return;
    setAckedAlerts((prev) => {
      const next = pruneAcked(prev, highIssues);
      if (next === prev) return prev;
      writeAckedAlerts(next);
      return next;
    });
  }, [fleet, highIssues]);

  const ackAlert = useCallback((issue: { boardId: string; kind: string; message: string }) => {
    setAckedAlerts((prev) => {
      const next = new Set(prev);
      next.add(alertKey(issue));
      writeAckedAlerts(next);
      return next;
    });
  }, []);

  const ackAllAlerts = useCallback(() => {
    setAckedAlerts((prev) => {
      const next = new Set(prev);
      for (const i of highIssues) next.add(alertKey(i));
      writeAckedAlerts(next);
      return next;
    });
  }, [highIssues]);

  /**
   * Project commits for the bound source repo, pulled lazily the first time a
   * card is opened on this board. The server already tags each commit with the
   * card ids named in its subject, so this is a join, not a new metric — and
   * nothing is stored on the card (a sha on frontmatter would go stale on
   * rebase; git stays the source of truth).
   *
   * `enabled` is the whole laziness mechanism now: no card open, no request.
   * The board id is part of the key rather than a marker the effect had to
   * check, which is what used to make this read cancel itself. An unbound repo
   * answers `commits: []` and a failed read answers nothing at all — both leave
   * the map empty, so the detail panel renders no commits section.
   */
  const codeHistoryQ = useCodeHistory(
    boardId,
    CARD_COMMIT_LIMIT,
    Boolean(selected),
  );
  const commitsByCard = useMemo(
    () => commitsByCardId(codeHistoryQ.data?.commits),
    [codeHistoryQ.data?.commits],
  );

  /**
   * Project-history columns. Same three cells as the card-detail commit lists,
   * but the subject links out and the row carries a strip of card jump buttons,
   * so this one closes over board state and has to be built per render.
   */
  const projectCommitColumns = useMemo<DataTableColumn<ProjectCommit>[]>(
    () => [
      {
        id: "sha",
        accessorFn: (c) => c.sha,
        cell: (ctx) => (
          <code className="kb-history-sha">
            {ctx.row.original.sha.slice(0, 7)}
          </code>
        ),
      },
      {
        id: "subject",
        header: "subject",
        accessorFn: (c) => c.subject,
        cell: (ctx) => {
          const c = ctx.row.original;
          return c.url ? (
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
          );
        },
      },
      {
        id: "cards",
        // Card ids are searchable — "find the commit that touched c-a1b2" is the
        // whole reason this list has a filter — but not a sort key, so no header.
        accessorFn: (c) => (c.cardIds ?? []).join(" "),
        cell: (ctx) => {
          const c = ctx.row.original;
          if (!c.cardIds || c.cardIds.length === 0) return null;
          return (
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
          );
        },
      },
      ...commitBylineColumns<ProjectCommit>(),
    ],
    [board],
  );

  const columns = useMemo(() => board?.columns ?? [], [board]);
  /** Column → accent, resolved against the whole board so no two share a hue. */
  const colAccents = useMemo(
    () => columnAccents(columns.map((c) => c.id)),
    [columns],
  );

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
        const r = await setActiveRemoteAsync(slug);
        setRemoteSlug(r.active);
        setSelected(null);
        setBoardId(null);
        await reload(boardHint);
      } catch (e) {
        setLocalError(String(e));
      } finally {
        setBusy(false);
      }
    },
    [reload, setActiveRemoteAsync],
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
      checklist?: ChecklistItem[];
    }) => {
      if (!boardId || !selected) return;
      setBusy(true);
      try {
        const res = await updateCardAsync({
          boardId,
          cardId: selected.id,
          patch,
        });
        setStatus(`Updated ${selected.id}`);
        setSelected(res.card);
      } catch (e) {
        setLocalError(String(e));
      } finally {
        setBusy(false);
      }
    },
    [boardId, selected, updateCardAsync],
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
      const res = await archiveCardsAsync({ boardId, body: { cardIds: ids } });
      setSelectedIds(new Set());
      setStatus(`Archived ${res.archived?.length ?? ids.length} card(s)`);
    } catch (e) {
      setLocalError(String(e));
    } finally {
      setBusy(false);
    }
  }, [boardId, selectedIds, archiveCardsAsync]);

  const onPullRemote = useCallback(async () => {
    setBusy(true);
    setLocalError(null);
    try {
      const r = await pullRemoteAsync();
      setStatus(
        r.fastForwarded
          ? `Fetched remote · fast-forwarded${r.healed.length ? ` · healed ${r.healed.length}` : ""}`
          : `Fetched remote · up to date${r.healed.length ? ` · healed ${r.healed.length}` : ""}`,
      );
    } catch (e) {
      setLocalError(String(e));
    } finally {
      setBusy(false);
    }
  }, [pullRemoteAsync]);

  const onArchiveOlder = useCallback(async () => {
    if (!boardId) return;
    setBusy(true);
    try {
      const res = await archiveCardsAsync({
        boardId,
        body: { olderThanKeep: 20 },
      });
      setStatus(`Archived ${res.archived.length} cards`);
      setSelected(null);
    } catch (e) {
      setLocalError(String(e));
    } finally {
      setBusy(false);
    }
  }, [boardId, archiveCardsAsync]);

  const onRemapColumn = useCallback(
    async (from: string, to: string) => {
      if (!boardId) return;
      setBusy(true);
      try {
        const res = await remapColumnAsync({ boardId, from, to });
        setStatus(`Remapped ${res.remapped.length} cards ${from} → ${to}`);
      } catch (e) {
        setLocalError(String(e));
      } finally {
        setBusy(false);
      }
    },
    [boardId, remapColumnAsync],
  );

  /**
   * Keep-mine / keep-theirs / heal are the same call with a different verb; the
   * three copies this replaces only differed in their status string.
   */
  const onResolveConflict = useCallback(
    async (
      conflictBoardId: string,
      cardId: string,
      choice: "mine" | "theirs" | "heal",
      verb: string,
    ) => {
      try {
        const r = await resolveConflictAsync({
          boardId: conflictBoardId,
          cardId,
          choice,
        });
        // A frozen card can live on a board other than the open one; the
        // mutation only knows about its own.
        if (boardId && boardId !== conflictBoardId) await inv.board(boardId);
        setStatus(
          r.remaining === 0
            ? "All conflicts resolved — sync unfrozen"
            : `${verb} · ${r.remaining} remaining`,
        );
      } catch (e) {
        setLocalError(String(e));
      }
    },
    [boardId, inv, resolveConflictAsync],
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
      retrySyncAsync()
        .then((s) => {
          setStatus(
            s.status === "synced"
              ? "Pushed pending changes"
              : s.label,
          );
        })
        .catch((e) => setLocalError(String(e)))
        .finally(() => setBusy(false));
      return;
    }
    // synced / syncing — still open repos for visibility
    setBoardMenuOpen(false);
    setShowSettings(true);
    setSettingsNav("repositories");
  }, [sync, retrySyncAsync]);

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
    // No `onClose`: this menu is dismissed today by the kb-app root's onClick
    // (see the app shell below), and letting Popover own dismissal would both
    // race that handler and add Escape/in-header dismissal it does not have.
    <Popover
      open={boardMenuOpen}
      className="kb-board-picker"
      testId="board-picker"
      panelClassName="kb-board-menu"
      panelTestId="board-menu"
      role="listbox"
      ariaLabel="Boards"
      anchor={
        <>
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
          <CountBadge
            className="kb-card-count-badge"
            value={totalCardCount}
            title="Cards on this board"
            data-testid="card-count-badge"
          />
        </>
      }
    >
      <div className="kb-board-menu-heading">boards</div>
      <div className="kb-board-menu-list">
        {boards.map((b) => (
          <MenuItem
            key={b.id}
            role="option"
            selected={b.id === boardId}
            className={
              b.id === boardId
                ? "kb-board-menu-item is-active"
                : "kb-board-menu-item"
            }
            testId={`board-menu-item-${b.id}`}
            onClick={() => {
              setBoardMenuOpen(false);
              setBoardId(b.id);
              reload(b.id).catch((err) => setLocalError(String(err)));
            }}
          >
            <span title={b.id}>{b.title || b.id}</span>
            <CountBadge className="kb-board-menu-count" value={b.cardCount} />
          </MenuItem>
        ))}
      </div>
      <MenuItem
        className="kb-board-menu-new"
        testId="board-menu-new"
        onClick={() => {
          setBoardMenuOpen(false);
          const name = window.prompt("New board name");
          if (name?.trim()) void onCreateBoard(name.trim());
        }}
      >
        + new board
      </MenuItem>
    </Popover>
  );

  const openPortfolio = useCallback(() => {
    // Clearing boardId is what blanks the board and enables the two portfolio
    // queries; refetching them keeps the roll-up honest on a deliberate visit.
    setShowPortfolio(true);
    setBoardId(null);
    setSelected(null);
    // formatBoardPath(null, …) is "/" whatever the slug, so the slug is dropped
    // here exactly as it was before. See legacySlugReplace for why the
    // push/replace choice depends on it.
    navigateTo(
      { kind: "board", boardId: null, cardId: null, remoteSlug: null },
      { replace: legacySlugReplace(remoteSlug) },
    );
    void Promise.all([inv.portfolio(), inv.fleet()]);
  }, [navigateTo, remoteSlug, inv]);

  const openBoardFromPortfolio = useCallback(
    (id: string) => {
      setShowPortfolio(false);
      // `remoteSlug` is deliberately not threaded into the path: the pre-router
      // call passed it where an options object belongs, so it never reached the
      // URL and this wrote a bare /b/<id>, which the sync effect then rewrites
      // to the slug-qualified path. See legacySlugReplace.
      navigateTo(
        { kind: "board", boardId: id, cardId: null, remoteSlug: null },
        { replace: legacySlugReplace(remoteSlug) },
      );
      void reload(id);
    },
    [navigateTo, remoteSlug, reload],
  );

  /** The 20 newest entries across every board. Memoized so the slice — and with
   *  it the table's row model — survives an unrelated re-render. */
  const portfolioActivity = useMemo(
    () => (portfolio?.activity ?? []).slice(0, PORTFOLIO_ACTIVITY_LIMIT),
    [portfolio?.activity],
  );

  const portfolioActivityColumns = useMemo<
    DataTableColumn<CrossBoardActivityEntry>[]
  >(
    () => [
      {
        id: "date",
        header: "date",
        accessorFn: (e) => e.date,
        sortDescFirst: true,
        cell: (ctx) => (
          <span className="kb-activity-date">{ctx.row.original.date}</span>
        ),
      },
      {
        id: "board",
        header: "board",
        accessorFn: (e) => e.boardTitle,
        cell: (ctx) => (
          <button
            type="button"
            className="kb-activity-card"
            onClick={() => openBoardFromPortfolio(ctx.row.original.boardId)}
          >
            {ctx.row.original.boardTitle}
          </button>
        ),
      },
      {
        id: "card",
        header: "card",
        accessorFn: (e) => e.cardTitle,
        cell: (ctx) => (
          <span className="kb-muted">{ctx.row.original.cardTitle}</span>
        ),
      },
      {
        // The log line is prose: worth searching, meaningless to sort by, so it
        // gets an accessor but no header.
        id: "line",
        accessorFn: (e) => e.line,
        cell: (ctx) => (
          <span className="kb-activity-line">{ctx.row.original.line}</span>
        ),
      },
    ],
    [openBoardFromPortfolio],
  );

  /**
   * Settings' activity feed: the same three cells as the portfolio digest, but
   * scoped to one board, so the card column jumps straight into the card rather
   * than switching boards. At ACTIVITY_LIMIT entries this is the longest flat
   * list in the app, which is why it gets the search box.
   */
  const activityColumns = useMemo<DataTableColumn<ActivityEntry>[]>(
    () => [
      {
        id: "date",
        header: "date",
        accessorFn: (e) => e.date,
        sortDescFirst: true,
        cell: (ctx) => (
          <span className="kb-activity-date">{ctx.row.original.date}</span>
        ),
      },
      {
        id: "card",
        header: "card",
        accessorFn: (e) => e.cardTitle || e.cardId,
        cell: (ctx) => {
          const e = ctx.row.original;
          return (
            <button
              type="button"
              className="kb-activity-card"
              data-testid={`activity-card-${e.cardId}`}
              onClick={() => {
                const c = board?.cards.find((x) => x.id === e.cardId);
                if (c) {
                  setFocusedCardId(c.id);
                  setSelected(c);
                  setShowSettings(false);
                }
              }}
            >
              {e.cardTitle || e.cardId}
            </button>
          );
        },
      },
      {
        id: "line",
        accessorFn: (e) => e.line,
        cell: (ctx) => (
          <span className="kb-activity-line">{ctx.row.original.line}</span>
        ),
      },
    ],
    [board],
  );

  const appHeader = (
    <header className="kb-navbar" data-testid="app-navbar">
      {brand}
      {boards.length > 0 ? (
        <ToolbarButton
          on={showPortfolio}
          data-testid="portfolio-open"
          title="All projects at a glance"
          onClick={openPortfolio}
        >
          Projects
        </ToolbarButton>
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
      <SegmentedControl
        className="kb-priority-seg"
        label="Priority filter"
        testId="priority-filter"
        value={filterPriority}
        onChange={setFilterPriority}
        items={(["", "P0", "P1", "P2"] as const).map((p) => ({
          value: p,
          // The "all" segment's value is the empty string, which is not a
          // usable React key.
          key: p || "all",
          label: p || "all",
          testId: `priority-filter-${p || "all"}`,
        }))}
      />
      {boardId ? (
        <>
          <ToolbarButton
            data-testid="board-notes-open"
            title="Project notes (NOTES.md)"
            onClick={() => {
              if (!boardId) return;
              // Dropping the draft re-arms the editor on whatever the query
              // returns for this board; opening it enables the read.
              setNotesDraft(null);
              setShowNotes(true);
            }}
          >
            Notes
          </ToolbarButton>
          <ToolbarButton
            data-testid="board-history-open"
            title="Project code commits (not boards git log)"
            onClick={() => {
              if (!boardId) return;
              setCodePathDraft(null);
              setCodeRemoteDraft(null);
              setShowHistory(true);
            }}
          >
            History
          </ToolbarButton>
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
      <IconButton
        data-testid="refresh-now"
        title={refreshing ? "Refreshing…" : "Fetch from git and reload boards"}
        aria-label="Refresh from git"
        disabled={refreshing}
        onClick={() => {
          refreshNow(undefined, {
            onSuccess: (r) =>
              setStatus(
                r.changed
                  ? `Refreshed — new commit ${r.sha.slice(0, 7)}`
                  : "Refreshed — already up to date",
              ),
            onError: (e) => setError(String(e)),
          });
        }}
      >
        <span className={refreshing ? "kb-spin" : undefined}>⟳</span>
      </IconButton>
      {selectedIds.size > 0 ? (
        <IconButton
          data-testid="bulk-archive"
          onClick={() => void bulkArchiveSelected()}
          disabled={busy}
          title={`Archive ${selectedIds.size} selected`}
        >
          ⌫
        </IconButton>
      ) : null}
      {highIssues.length > 0 ? (
        // No `onClose`, for the same reason as the board picker above.
        <Popover
          open={showAlerts}
          className="kb-alerts"
          panelClassName="kb-alerts-menu"
          panelTestId="fleet-alerts"
          role="dialog"
          ariaLabel="Fleet alerts"
          anchor={
            <IconButton
              className={`kb-alerts-btn${
                unackedAlerts.length === 0 ? " is-quiet" : ""
              }`}
              data-testid="alerts-toggle"
              title={
                unackedAlerts.length > 0
                  ? `${unackedAlerts.length} new alert${unackedAlerts.length === 1 ? "" : "s"}`
                  : `${highIssues.length} alert${highIssues.length === 1 ? "" : "s"}, all acknowledged`
              }
              aria-label={`Alerts: ${unackedAlerts.length} unread of ${highIssues.length}`}
              aria-expanded={showAlerts}
              onClick={() => {
                setBoardMenuOpen(false);
                setShowAlerts((v) => !v);
              }}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M8 2a4 4 0 0 0-4 4c0 2.5-.7 3.9-1.3 4.6a.5.5 0 0 0 .37.84h9.86a.5.5 0 0 0 .37-.84C12.7 9.9 12 8.5 12 6a4 4 0 0 0-4-4Z" />
                <path d="M6.5 13.5a1.6 1.6 0 0 0 3 0" />
              </svg>
              {unackedAlerts.length > 0 ? (
                <CountBadge
                  className="kb-alerts-count"
                  value={unackedAlerts.length}
                  data-testid="alerts-count"
                />
              ) : null}
            </IconButton>
          }
        >
          <div className="kb-alerts-menu-head">
            <span>needs attention</span>
            {unackedAlerts.length > 0 ? (
              <button
                type="button"
                className="kb-alerts-ackall"
                data-testid="alerts-ack-all"
                onClick={ackAllAlerts}
              >
                mark all read
              </button>
            ) : null}
          </div>
          <div className="kb-alerts-list">
            {highIssues.slice(0, 8).map((i, idx) => (
              <MenuItem
                key={`${i.boardId}-${i.kind}-${idx}`}
                className={`kb-alerts-item${
                  ackedAlerts.has(alertKey(i)) ? " is-acked" : ""
                }`}
                onClick={() => {
                  ackAlert(i);
                  setShowAlerts(false);
                  openBoardFromPortfolio(i.boardId);
                }}
              >
                <span className="kb-alerts-board">{i.boardTitle}</span>
                <span className="kb-alerts-msg">{i.message}</span>
              </MenuItem>
            ))}
          </div>
        </Popover>
      ) : null}
      <IconButton
        data-testid="theme-select"
        data-theme-pref={themePref}
        title={themeTitle}
        aria-label={themeTitle}
        onClick={cycleTheme}
      >
        <span data-testid={`theme-${themePref}`}>{themeGlyph}</span>
      </IconButton>
      <IconButton
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
      </IconButton>
      <IconButton
        data-testid="help-toggle"
        title="Keyboard shortcuts"
        aria-expanded={showHelp}
        onClick={() => setShowHelp((v) => !v)}
      >
        ?
      </IconButton>
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
          <EmptyState>
            Connect a boards repo with <code>--repo &lt;path&gt;</code>, or open
            Settings ⚙.
          </EmptyState>
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
        if (showAlerts) setShowAlerts(false);
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
            <div className="kb-portfolio-head-row">
              <h2 className="kb-portfolio-title">Projects</h2>
              <span className="kb-portfolio-head-meta">
                {(portfolio?.tiles ?? []).length} boards
                {portfolio ? ` · ${portfolio.p0Total} P0` : ""}
                {portfolio?.velocity
                  ? ` · ${portfolio.velocity.done7d} done/7d`
                  : ""}
              </span>
            </div>
            <EmptyState testId="portfolio-summary">
              Progress across every board. Open one to work the cards.
              {portfolio?.staleTotal ? ` ${portfolio.staleTotal} stale.` : ""}
              {portfolio?.velocity
                ? ` ${portfolio.velocity.agentEvents7d} agent logs and ${portfolio.velocity.codeCommits24h ?? 0} code commits in the last 24h.`
                : ""}
            </EmptyState>
          </div>
          {/* Fleet alerts live behind the header bell — the design keeps this
              page to a heading plus the board grid. */}
          <div className="kb-portfolio-grid">
            {(portfolio?.tiles ?? []).map((t) => {
              const colIds = Object.keys(t.columnCounts ?? {});
              const tileAccents = columnAccents(colIds);
              const total = t.cardCount || 0;
              // Design treats the last column as "done".
              const doneId = colIds[colIds.length - 1];
              const doneCount = doneId ? (t.columnCounts[doneId] ?? 0) : 0;
              const pct = total ? Math.round((doneCount / total) * 100) : 0;
              const health = t.health ?? "idle";
              const attention =
                t.p0Count > 0 ||
                health === "blocked" ||
                health === "stale" ||
                health === "silent";
              return (
                <button
                  key={t.boardId}
                  type="button"
                  className={`kb-portfolio-tile kb-portfolio-tile--${health}`}
                  data-testid={`portfolio-tile-${t.boardId}`}
                  data-health={health}
                  onClick={() => openBoardFromPortfolio(t.boardId)}
                >
                  <div className="kb-portfolio-tile-top">
                    <div className="kb-portfolio-ident">
                      <div className="kb-portfolio-name">{t.title}</div>
                      <div className="kb-portfolio-submeta">
                        {total} cards · {colIds.length} columns
                      </div>
                    </div>
                    <Chip
                      base="kb-portfolio-health"
                      variant={health}
                      className={attention ? "is-attention" : undefined}
                      data-testid={`portfolio-health-${t.boardId}`}
                    >
                      {health}
                    </Chip>
                  </div>

                  <div className="kb-portfolio-progress">
                    <div className="kb-portfolio-progress-head">
                      <span className="kb-portfolio-progress-label">
                        complete
                      </span>
                      <Chip base="kb-portfolio-pct">{pct}%</Chip>
                    </div>
                    <SegmentBar
                      segments={colIds.map((id) => ({
                        key: id,
                        weight: t.columnCounts[id] ?? 0,
                        color: tileAccents[id],
                        title: `${columnLabel(id)}: ${t.columnCounts[id] ?? 0}`,
                      }))}
                    />
                  </div>

                  <div className="kb-portfolio-colstats">
                    {colIds.map((id) => (
                      <div key={id} className="kb-portfolio-colstat">
                        <Dot color={tileAccents[id]} />
                        <span className="kb-portfolio-colname">
                          {columnLabel(id)}
                        </span>
                        <CountBadge
                          className="kb-portfolio-colcount"
                          value={t.columnCounts[id] ?? 0}
                        />
                      </div>
                    ))}
                  </div>

                  {/* Footer carries kanbanly's own signals — throughput,
                      exceptions, who is working it — inside the design's
                      single divided block rather than as stacked strips. */}
                  <div className="kb-portfolio-foot">
                    <div
                      className="kb-portfolio-velocity"
                      data-testid={`portfolio-vel-${t.boardId}`}
                    >
                      <span>{t.velocity?.done7d ?? 0} done/7d</span>
                      <span>
                        {t.velocity?.codeCommits7d == null
                          ? "code —"
                          : `${t.velocity.codeCommits7d} commits/7d`}
                      </span>
                      <span>
                        {formatPulseAge(t.velocity?.pulseAgeHours ?? null)}
                      </span>
                      {t.velocity?.agentEvents7d ? (
                        <span>{t.velocity.agentEvents7d} agent logs/7d</span>
                      ) : null}
                    </div>

                    {/* Exceptions only — routine counts already read off the
                        column stats above. */}
                    {t.blockedCount > 0 ||
                    t.staleDoingCount > 0 ||
                    t.wipDoing?.over ||
                    t.codeBound ? (
                      <div className="kb-portfolio-badges">
                        {t.blockedCount > 0 ? (
                          <Chip base="kb-portfolio-badge" variant="blocked">
                            {t.blockedCount} blocked
                          </Chip>
                        ) : null}
                        {t.staleDoingCount > 0 ? (
                          <Chip base="kb-portfolio-badge" variant="stale">
                            {t.staleDoingCount} stale
                          </Chip>
                        ) : null}
                        {t.wipDoing?.over ? (
                          <Chip base="kb-portfolio-badge" variant="stale">
                            WIP {t.wipDoing.count}/{t.wipDoing.limit}
                          </Chip>
                        ) : null}
                        {t.codeBound ? (
                          <Chip base="kb-portfolio-badge" variant="code">
                            source
                          </Chip>
                        ) : null}
                      </div>
                    ) : null}

                    <div className="kb-portfolio-foot-row">
                      <div className="kb-portfolio-avatars">
                        {t.lastAgent ? (
                          <Avatar
                            name={t.lastAgent}
                            title={`Last actor: ${t.lastAgent}`}
                          />
                        ) : null}
                        {t.lastActivity ? (
                          <span
                            className="kb-portfolio-lastline"
                            title={t.lastActivity.line}
                          >
                            {t.lastActivity.cardTitle}
                          </span>
                        ) : null}
                      </div>
                      <span className="kb-portfolio-risk">
                        {t.p0Count > 0
                          ? `${t.p0Count} × P0 open`
                          : `${doneCount}/${total} done`}
                      </span>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
          {(portfolio?.activity?.length ?? 0) > 0 ? (
            <details className="kb-portfolio-activity" data-testid="portfolio-activity">
              <summary className="kb-portfolio-activity-summary">
                <span>Recent activity</span>
                <CountBadge
                  className="kb-portfolio-activity-count"
                  value={portfolio!.activity.length}
                />
              </summary>
              <DataTable
                data={portfolioActivity}
                columns={portfolioActivityColumns}
                listClassName="kb-activity-list"
                getRowId={(e, i) => `${e.boardId}-${e.cardId}-${i}`}
                sortLabel="Sort recent activity"
              />
            </details>
          ) : null}
        </div>
      ) : null}

      {needsConnect || boards.length === 0 ? (
        <div className="kb-connect" data-testid="connect-wizard">
          <h2>Connect a boards repo</h2>
          <EmptyState>
            Paste a git remote URL (optional PAT) or a local path. Empty repos
            are scaffolded with a starter board.
          </EmptyState>
          <form
            className="kb-connect-form"
            onSubmit={(e) => {
              e.preventDefault();
              setLocalError(null);
              connectRepoAsync({
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
                  setConnectToken("");
                  // Land on portfolio home (multi-project radar), not a random
                  // first board. formatBoardPath(null, …) is "/" whatever the
                  // slug; see legacySlugReplace for the push/replace choice.
                  navigateTo(
                    {
                      kind: "board",
                      boardId: null,
                      cardId: null,
                      remoteSlug: null,
                    },
                    { replace: legacySlugReplace(r.slug) },
                  );
                  await reload();
                })
                .catch((err) => setLocalError(String(err)));
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
            onClick={() => void retrySyncAsync().catch((e) => setLocalError(String(e)))}
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
              // The mutation saves the PAT and retries the push as one unit —
              // a credential nobody has pushed with is not yet proven good.
              setCredentialsAsync({
                token: credToken,
                username: credUser || undefined,
              })
                .then(() => {
                  setCredToken("");
                  setStatus("Credential saved — push retried");
                })
                .catch((err) => setLocalError(String(err)));
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
              onClick={() => void retrySyncAsync().catch((e) => setLocalError(String(e)))}
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
                        void onResolveConflict(
                          c.boardId,
                          c.cardId,
                          "mine",
                          "Kept mine",
                        )
                      }
                    >
                      Keep mine
                    </button>
                    <button
                      type="button"
                      data-testid={`keep-theirs-${c.cardId}`}
                      onClick={() =>
                        void onResolveConflict(
                          c.boardId,
                          c.cardId,
                          "theirs",
                          "Kept theirs",
                        )
                      }
                    >
                      Keep theirs
                    </button>
                    <button
                      type="button"
                      data-testid={`keep-heal-${c.cardId}`}
                      onClick={() =>
                        void onResolveConflict(
                          c.boardId,
                          c.cardId,
                          "heal",
                          "Healed",
                        )
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
              void clearSyncFreezeAsync().catch((e) =>
                setLocalError(String(e)),
              )
            }
          >
            Unfreeze sync
          </button>
          <button
            type="button"
            data-testid="banner-conflict-retry"
            onClick={() => void retrySyncAsync().catch((e) => setLocalError(String(e)))}
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
              <ToolbarButton data-testid="filter-clear" onClick={clearFilters}>
                Clear
              </ToolbarButton>
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
                          <Chip base="kb-card-id">{c.id}</Chip>
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
                    accent={colAccents[col.id]}
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
      ) : showPortfolio ? null : (
        <p data-testid="empty-state">No boards connected.</p>
      )}
      </div>

      {selected && board ? (
        <DetailPanel
          card={board.cards.find((c) => c.id === selected.id) ?? selected}
          boardId={board.id}
          accent={colAccents[(board.cards.find((c) => c.id === selected.id) ?? selected).column]}
          commits={commitsByCard.get(selected.id.toLowerCase()) ?? []}
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
              onChange={(e) => setNotesDraft(e.target.value)}
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
                  putBoardNotesAsync({ boardId, body: notesBody })
                    .then(() => {
                      setStatus("Saved project notes");
                      setShowNotes(false);
                    })
                    .catch((e) => setLocalError(String(e)));
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
            <Field label="Source remote URL">
              <input
                data-testid="board-code-remote"
                value={codeRemote}
                onChange={(e) => setCodeRemoteDraft(e.target.value)}
                placeholder="https://github.com/you/app.git"
              />
            </Field>
            <Field label="Or local path">
              <input
                data-testid="board-code-path"
                value={codePath}
                onChange={(e) => setCodePathDraft(e.target.value)}
                placeholder="/absolute/path/to/project"
              />
            </Field>
            <Field label="Saved credential">
              <select
                data-testid="board-code-credential"
                value={codeCredentialId}
                onChange={(e) => setCodeCredentialDraft(e.target.value)}
              >
                <option value="">
                  {credentialBook.length
                    ? "— none (use board credential) —"
                    : "— none saved —"}
                </option>
                {credentialBook.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                    {c.username ? ` (${c.username})` : ""}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Or paste a one-off PAT">
              <input
                data-testid="board-code-token"
                type="password"
                autoComplete="off"
                value={codeTokenDraft}
                onChange={(e) => setCodeTokenDraft(e.target.value)}
                placeholder="ghp_… fine-grained: Contents read"
              />
            </Field>
            <Field label="Watch instead of clone">
              <label className="kb-code-watch">
                <input
                  type="checkbox"
                  data-testid="board-code-watch"
                  checked={codeWatch}
                  onChange={(e) => setCodeWatchDraft(e.target.checked)}
                />
                <span>
                  Read commits from the GitHub API — nothing is cloned to disk.
                  Requires a github.com remote and a credential that can read it.
                </span>
              </label>
            </Field>
            <div className="kb-card-modal-actions" style={{ marginBottom: 12 }}>
              <ToolbarButton
                data-testid="board-code-connect"
                disabled={
                  historyBusy || (!codePath.trim() && !codeRemote.trim())
                }
                onClick={() => {
                  // The mutation writes the echoed history into the same cache
                  // slot this modal reads, then invalidates it, so the panel
                  // paints once and reconciles once — not twice, as the
                  // hand-rolled "set state, then re-GET, then set it again"
                  // version did.
                  bindCodeSourceAsync({
                    boardId,
                    path: codePath.trim() || undefined,
                    url: codeRemote.trim() || undefined,
                    token: codeTokenDraft.trim() || undefined,
                    credentialId: codeCredentialId.trim() || undefined,
                    watch: codeWatch || undefined,
                    limit: PROJECT_HISTORY_LIMIT,
                  })
                    .then((res) => {
                      setCodeTokenDraft("");
                      // Hand the fields back to the server's answer.
                      setCodePathDraft(null);
                      setCodeRemoteDraft(null);
                      setCodeCredentialDraft(null);
                      setCodeWatchDraft(null);
                      setStatus(
                        res.source?.cloned
                          ? "Cloned source repo and linked History"
                          : res.history?.bound
                            ? "Linked source repo for History"
                            : res.history?.error || "Source binding saved",
                      );
                    })
                    .catch((e) => setLocalError(String(e)));
                }}
              >
                Connect source
              </ToolbarButton>
            </div>
            {historyBusy ? (
              <EmptyState>Loading…</EmptyState>
            ) : projectHistory && !projectHistory.bound ? (
              <EmptyState testId="board-history-unbound">
                {projectHistory.error ||
                  "No source code repo bound. Paste a remote URL (with PAT) or a local path."}
              </EmptyState>
            ) : historyCommits.length === 0 ? (
              <EmptyState testId="board-history-empty">
                No commits found in the bound project repo.
              </EmptyState>
            ) : (
              <DataTable
                data={historyCommits}
                columns={projectCommitColumns}
                listClassName="kb-history-list"
                testId="board-history-list"
                getRowId={(c) => c.sha}
                rowTestId="project-commit"
                hiddenColumns={COMMIT_HIDDEN_COLUMNS}
                sortLabel="Sort project history"
                filterPlaceholder="Search commits…"
                filterTestId="board-history-filter"
              />
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
            <ToolbarButton
              data-testid="settings-close"
              onClick={() => setShowSettings(false)}
            >
              ← board
            </ToolbarButton>
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
              <SectionTitle
                action={
                  <ToolbarButton
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
                  </ToolbarButton>
                }
              >
                boards
              </SectionTitle>
              <EmptyState>
                Configure each board here: credentials, git repository, and the
                directory inside that repo (layout A). Expand a board to edit.
              </EmptyState>

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
                  <SegmentedControl
                    className="kb-seg-row"
                    label="Repository source"
                    value={newBoardUseNewRepo ? "new" : "existing"}
                    onChange={(v) => setNewBoardUseNewRepo(v === "new")}
                    items={[
                      {
                        value: "existing",
                        label: "Existing repo",
                        disabled: (workspace?.connections.length ?? 0) === 0,
                      },
                      { value: "new", label: "New / enter repo" },
                    ]}
                  />
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

                  <ToolbarButton
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
                  </ToolbarButton>
                </div>
              ) : null}

              <DataTable
                data={workspaceBoards}
                columns={WORKSPACE_BOARD_COLUMNS}
                listClassName="kb-disclose-list"
                testId="settings-board-list"
                getRowId={(b) => b.key}
                rowClassName={(b) =>
                  expandedBoardKey === b.key ? "is-open" : undefined
                }
                sortLabel="Sort boards"
                filterPlaceholder="Search boards…"
                filterTestId="settings-board-filter"
                renderRow={(b) => {
                  const open = expandedBoardKey === b.key;
                  const draft =
                    editBoardDraft?.key === b.key ? editBoardDraft : null;
                  return (
                    <>
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
                          <EmptyState>
                            To attach a different git remote URL, use{" "}
                            <strong>Repositories</strong> below (or add a new
                            connection), then select it here. Board files live
                            under the chosen clone.
                          </EmptyState>

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
                            <ToolbarButton
                              data-testid={`settings-board-save-${b.boardId}`}
                              disabled={busy}
                              onClick={() => void saveBoardEditor()}
                            >
                              Save board config
                            </ToolbarButton>
                            <ToolbarButton
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
                                    .catch((e) => setLocalError(String(e)));
                                }
                              }}
                            >
                              Open board
                            </ToolbarButton>
                            <ToolbarButton
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
                            </ToolbarButton>
                          </div>
                        </div>
                      ) : null}
                    </>
                  );
                }}
              />
              {(workspace?.boards.length ?? 0) === 0 ? (
                <EmptyState>
                  No boards yet — use <strong>+ add board</strong> to create one
                  and attach a repository.
                </EmptyState>
              ) : null}
            </section>
            ) : null}

            {settingsNav === "repositories" ? (
            <section className="kb-settings-section" data-testid="settings-remotes">
              <SectionTitle
                action={
                  <ToolbarButton
                    data-testid="settings-add-connection-toggle"
                    onClick={() => setShowAddConnection((v) => !v)}
                  >
                    {showAddConnection ? "cancel" : "+ add repository"}
                  </ToolbarButton>
                }
              >
                repositories
              </SectionTitle>
              <EmptyState>
                Git clones available for boards. Prefer configuring repo +
                credentials on each <strong>board</strong> above; manage shared
                clones and default credentials here.
              </EmptyState>

              {showAddConnection ? (
                <form
                  className="kb-disclose kb-connect-form"
                  data-testid="settings-add-connection"
                  onSubmit={(e) => {
                    e.preventDefault();
                    setLocalError(null);
                    connectRepoAsync({
                      url: connectUrl.trim() || undefined,
                      path: connectPath.trim() || undefined,
                      token: connectToken.trim() || undefined,
                      scaffold: true,
                    })
                      .then(async (r) => {
                        setStatus(`Connected ${r.path}`);
                        if (r.slug) setRemoteSlug(r.slug);
                        if (connectToken.trim()) {
                          try {
                            await upsertCredentialAsync({
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
                        setShowAddConnection(false);
                      })
                      .catch((err) => setLocalError(String(err)));
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

              <DataTable
                data={workspaceConnections}
                columns={WORKSPACE_CONNECTION_COLUMNS}
                listClassName="kb-disclose-list"
                testId="remote-sidebar"
                getRowId={(r) => r.id}
                rowClassName={(r) =>
                  expandedConnectionId === r.id ? "is-open" : undefined
                }
                sortLabel="Sort repositories"
                renderRow={(r) => {
                  const open = expandedConnectionId === r.id;
                  return (
                    <>
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
                                void patchConnectionAsync({
                                  id: r.id,
                                  defaultCredentialId: v === "" ? null : v,
                                }).catch((err) => setLocalError(String(err)));
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
                            <ToolbarButton
                              disabled={r.active || busy}
                              onClick={() => void switchRemote(r.id)}
                            >
                              {r.active ? "active" : "set active"}
                            </ToolbarButton>
                          </div>
                        </div>
                      ) : null}
                    </>
                  );
                }}
              />
            </section>
            ) : null}

            {settingsNav === "credentials" ? (
            <section className="kb-settings-section" data-testid="settings-credentials">
              <SectionTitle
                action={
                  <ToolbarButton
                    data-testid="settings-add-cred-toggle"
                    onClick={() => setShowAddCredential((v) => !v)}
                  >
                    {showAddCredential ? "cancel" : "+ add credential"}
                  </ToolbarButton>
                }
              >
                credentials
              </SectionTitle>
              <EmptyState>
                Named HTTPS PATs (encrypted under ~/.kanbanly/). Assign per
                board or as a connection default. SSH still uses your agent.
              </EmptyState>

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
                  <ToolbarButton
                    data-testid="settings-cred-submit"
                    disabled={!newCredLabel.trim() || !newCredToken.trim()}
                    onClick={() => {
                      void upsertCredentialAsync({
                        label: newCredLabel.trim(),
                        username: newCredUser.trim() || "x-access-token",
                        token: newCredToken.trim(),
                      })
                        .then(() => {
                          setNewCredLabel("");
                          setNewCredToken("");
                          setShowAddCredential(false);
                        })
                        .catch((e) => setLocalError(String(e)));
                    }}
                  >
                    Save credential
                  </ToolbarButton>
                </div>
              ) : null}

              <DataTable
                data={workspaceCredentials}
                columns={WORKSPACE_CREDENTIAL_COLUMNS}
                listClassName="kb-disclose-list"
                testId="settings-cred-list"
                getRowId={(c) => c.id}
                sortLabel="Sort credentials"
                renderRow={(c) => (
                  <div className="kb-disclose-row kb-disclose-row--static">
                    <span className="kb-disclose-row-main">
                      <strong>{c.label}</strong>
                      <span className="kb-muted">
                        {c.username} · {c.id} ·{" "}
                        {new Date(c.updatedAt).toLocaleString()}
                      </span>
                    </span>
                    <ToolbarButton
                      data-testid={`settings-cred-delete-${c.id}`}
                      onClick={() => {
                        if (
                          window.confirm(
                            `Delete credential “${c.label}”? Boards using it fall back to connection default.`,
                          )
                        ) {
                          void deleteCredentialAsync(c.id).catch((e) =>
                            setLocalError(String(e)),
                          );
                        }
                      }}
                    >
                      delete
                    </ToolbarButton>
                  </div>
                )}
              />
              {(workspace?.credentials.length ?? 0) === 0 ? (
                <EmptyState>No named credentials yet.</EmptyState>
              ) : null}
            </section>
            ) : null}

            {settingsNav === "filters" ? (
            <section className="kb-settings-section">
              <SectionTitle>filters</SectionTitle>
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
              <SectionTitle>theme</SectionTitle>
              <SegmentedControl
                className="kb-theme-switch"
                label="Theme"
                // This strip marks its active segment with aria-pressed, not
                // `.is-on` — styles.css targets `button[aria-pressed="true"]`.
                marker="aria-pressed"
                value={themePref}
                onChange={setThemePref}
                items={[
                  { value: "light", label: "light" },
                  { value: "dark", label: "dark" },
                  { value: "system", label: "auto" },
                ]}
              />
            </section>
            ) : null}

            {settingsNav === "activity" ? (
            <section className="kb-settings-section" data-testid="settings-activity">
              {/* Head row with no action: the rule belongs on the row, so the
                  wrapper is requested explicitly. */}
              <SectionTitle head>activity</SectionTitle>
              <EmptyState>
                Recent card log entries from the open board.
              </EmptyState>
              <div
                className="kb-activity kb-activity--settings"
                data-testid="activity-feed"
              >
                {activity.length === 0 ? (
                  <EmptyState tone="empty">No log entries yet.</EmptyState>
                ) : (
                  <DataTable
                    data={activity}
                    columns={activityColumns}
                    listClassName="kb-activity-list"
                    getRowId={(e, i) => `${e.cardId}-${e.date}-${i}`}
                    rowTestId="activity-item"
                    sortLabel="Sort activity"
                    filterPlaceholder="Search activity…"
                    filterTestId="activity-filter"
                  />
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
