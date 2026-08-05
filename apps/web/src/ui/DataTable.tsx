/**
 * DataTable — TanStack Table (@tanstack/react-table) behind the app's
 * list-shaped UIs.
 *
 * Deliberately NOT a <table>. Every list this backs is styled by styles.css as
 * a flex <ul>/<li> stack: `.kb-history-list li` and `.kb-activity-list li` are
 * `flex-direction: column`, so a commit's sha / subject / byline already ARE
 * three columns that happen to stack vertically instead of sitting side by
 * side. Emitting <table> markup would strand every one of those rules. So the
 * table is used the way it is designed to be used — headlessly: the column defs
 * own the sort keys, the filter keys and the cell renderers, and this component
 * maps `row.getVisibleCells()` straight into the existing <li>.
 *
 * Cells render through a keyed <Fragment>, never a wrapper element, so the DOM
 * is byte-identical to the hand-written JSX each call site had before.
 *
 * Two invariants keep this a refactor rather than a redesign:
 *   1. Sorting starts empty. The first paint is always source order — whatever
 *      the server sent — so nothing moves until the user asks it to.
 *   2. The toolbar only appears once a list has more than one row. Sorting a
 *      single commit is noise, and most of these lists are usually short.
 */
import { Fragment, type ReactNode, useState } from "react";
import {
  type ColumnDef,
  type Row,
  type SortDirection,
  type SortingState,
  type VisibilityState,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { EmptyState } from "./Field.tsx";

/**
 * What an accessor may return. Strings sort with TanStack's `alphanumeric`
 * comparator (which orders embedded digits numerically, so "c-9" precedes
 * "c-10"); numbers sort with `basic`. Nothing else is needed here — accessors
 * exist to produce a sort/filter key, while cells render from `row.original`.
 */
export type DataTableValue = string | number;

/** A column definition for these lists. */
export type DataTableColumn<T> = ColumnDef<T, DataTableValue>;

/** Lower-case and trim, the shared normalization for query matching. */
export function normalizeQuery(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * True when every whitespace-separated term in `query` appears somewhere in
 * `haystack`, case-insensitively.
 *
 * AND-over-terms rather than one raw substring: searching a commit log for
 * "fix auth" should find "auth: fix the redirect loop", which a plain
 * `includes` would miss. An empty query matches everything.
 */
export function matchesQuery(haystack: string, query: string): boolean {
  const q = normalizeQuery(query);
  if (!q) return true;
  const hay = haystack.toLowerCase();
  return q.split(/\s+/).every((term) => hay.includes(term));
}

/**
 * Flatten a row's filterable values into one search target.
 *
 * Joining before matching (rather than testing each column separately) is what
 * lets a query span columns — "a1b2 redirect" matches a commit whose sha is in
 * one column and whose subject is in another.
 */
export function rowHaystack(
  values: ReadonlyArray<DataTableValue | null | undefined>,
): string {
  return values.map((v) => (v == null ? "" : String(v))).join(" ");
}

/** Arrow rendered inside a sort button for the column's current direction. */
export function sortGlyph(direction: SortDirection | false): string {
  if (direction === "asc") return "↑";
  if (direction === "desc") return "↓";
  return "↕";
}

/**
 * Accessible name for a sort button.
 *
 * Describes the current state rather than the next click, because the cycle
 * (ascending-first vs descending-first) is per-column and announcing the wrong
 * next step is worse than announcing none.
 */
export function sortStateLabel(
  header: string,
  direction: SortDirection | false,
): string {
  if (direction === "asc") return `${header}, sorted ascending`;
  if (direction === "desc") return `${header}, sorted descending`;
  return `Sort by ${header}`;
}

/**
 * Global filter: match the query against every globally-filterable column of a
 * row at once. TanStack calls this once per filterable column and keeps the row
 * if any call returns true, so returning the same answer each time is correct —
 * it just short-circuits on the first column for rows that match.
 */
export function dataTableGlobalFilter<T>(
  row: Row<T>,
  _columnId: string,
  filterValue: unknown,
): boolean {
  const query = typeof filterValue === "string" ? filterValue : "";
  if (!normalizeQuery(query)) return true;
  const values = row
    .getAllCells()
    .filter((cell) => cell.column.getCanGlobalFilter())
    .map((cell) => cell.getValue<DataTableValue | null | undefined>());
  return matchesQuery(rowHaystack(values), query);
}

/** Build the `columnVisibility` map that hides sort-only columns. */
export function hiddenColumnState(ids: readonly string[]): VisibilityState {
  const state: VisibilityState = {};
  for (const id of ids) state[id] = false;
  return state;
}

export type DataTableProps<T> = {
  data: T[];
  /**
   * Memoize this at the call site. TanStack rebuilds its row model whenever the
   * array identity changes, and cell renderers usually close over handlers.
   */
  columns: DataTableColumn<T>[];
  /** kb-* class for the <ul>: kb-history-list, kb-activity-list, … */
  listClassName: string;
  /** Stable, unique row id. Doubles as the React key on each <li>. */
  getRowId: (row: T, index: number) => string;
  /** data-testid for the <ul>, and the prefix for the sort buttons' testids. */
  testId?: string;
  /** data-testid stamped on every <li>. */
  rowTestId?: string;
  /** Extra class on the <li>, e.g. the disclosure list's "is-open". */
  rowClassName?: (row: T) => string | undefined;
  /**
   * Escape hatch for rows that are not cell-shaped. The settings disclosure
   * rows are a single interactive <button> plus a conditional 200-line panel,
   * not a stack of cells; there the column defs serve only as sort and filter
   * keys and this owns the <li> contents.
   */
  renderRow?: (row: T) => ReactNode;
  /**
   * Columns that exist only to sort or search by — a commit's author, say,
   * which is rendered as part of the byline cell rather than on its own.
   */
  hiddenColumns?: readonly string[];
  /** Renders the search box when set. Absent means no filter UI at all. */
  filterPlaceholder?: string;
  filterTestId?: string;
  /** Accessible name for the sort group. Absent means no sort strip. */
  sortLabel?: string;
  /** Shown when a filter query matches nothing. */
  noMatches?: ReactNode;
};

export function DataTable<T>({
  data,
  columns,
  listClassName,
  getRowId,
  testId,
  rowTestId,
  rowClassName,
  renderRow,
  hiddenColumns,
  filterPlaceholder,
  filterTestId,
  sortLabel,
  noMatches,
}: DataTableProps<T>) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [query, setQuery] = useState("");

  const table = useReactTable<T>({
    data,
    columns,
    state: { sorting, globalFilter: query },
    initialState: hiddenColumns
      ? { columnVisibility: hiddenColumnState(hiddenColumns) }
      : undefined,
    getRowId,
    onSortingChange: setSorting,
    onGlobalFilterChange: setQuery,
    globalFilterFn: dataTableGlobalFilter,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  });

  const wantsFilter = filterPlaceholder != null;
  // A column joins the sort strip by declaring a string header. Presentation-
  // only columns leave it off and stay out of the way.
  const sortableColumns =
    sortLabel != null
      ? table
          .getAllLeafColumns()
          .filter(
            (c) => c.getCanSort() && typeof c.columnDef.header === "string",
          )
      : [];
  // Keyed off the unfiltered length so the box cannot vanish under the cursor
  // the moment a query narrows the list to one row.
  const showToolbar =
    data.length > 1 && (wantsFilter || sortableColumns.length > 0);

  const rows = table.getRowModel().rows;
  const filteredEmpty = data.length > 0 && rows.length === 0;

  return (
    <>
      {showToolbar ? (
        <div className="kb-datatable-toolbar">
          {wantsFilter ? (
            <input
              className="kb-datatable-filter"
              type="search"
              value={query}
              placeholder={filterPlaceholder}
              aria-label={filterPlaceholder}
              data-testid={filterTestId}
              onChange={(e) => setQuery(e.target.value)}
            />
          ) : null}
          {sortableColumns.length > 0 ? (
            <div className="kb-datatable-sort" role="group" aria-label={sortLabel}>
              <span className="kb-datatable-sort-label">sort</span>
              {sortableColumns.map((column) => {
                const direction = column.getIsSorted();
                const header = String(column.columnDef.header);
                return (
                  <button
                    key={column.id}
                    type="button"
                    className="kb-datatable-sort-btn"
                    aria-pressed={direction !== false}
                    aria-label={sortStateLabel(header, direction)}
                    data-testid={
                      testId ? `${testId}-sort-${column.id}` : undefined
                    }
                    onClick={() => column.toggleSorting()}
                  >
                    {header}
                    <span className="kb-datatable-sort-dir" aria-hidden>
                      {sortGlyph(direction)}
                    </span>
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>
      ) : null}
      {filteredEmpty ? (
        (noMatches ?? (
          <EmptyState className="kb-datatable-empty">
            No matches for “{query.trim()}”.
          </EmptyState>
        ))
      ) : (
        <ul className={listClassName} data-testid={testId}>
          {rows.map((row) => (
            <li
              key={row.id}
              className={rowClassName?.(row.original)}
              data-testid={rowTestId}
            >
              {renderRow
                ? renderRow(row.original)
                : row.getVisibleCells().map((cell) => (
                    <Fragment key={cell.id}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </Fragment>
                  ))}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
