import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import {
  DataTable,
  type DataTableColumn,
  hiddenColumnState,
  matchesQuery,
  normalizeQuery,
  rowHaystack,
  sortGlyph,
  sortStateLabel,
} from "./DataTable.tsx";

const html = (el: ReactElement) => renderToStaticMarkup(el);

describe("normalizeQuery", () => {
  test("trims and lower-cases", () => {
    expect(normalizeQuery("  Fix Auth ")).toBe("fix auth");
  });

  test("whitespace only is empty", () => {
    expect(normalizeQuery("   ")).toBe("");
  });
});

describe("matchesQuery", () => {
  test("an empty query matches everything", () => {
    expect(matchesQuery("anything", "")).toBe(true);
    expect(matchesQuery("anything", "   ")).toBe(true);
  });

  test("matches case-insensitively", () => {
    expect(matchesQuery("Fix The Redirect", "redirect")).toBe(true);
  });

  test("every term must appear, in any order", () => {
    expect(matchesQuery("auth: fix the redirect loop", "fix auth")).toBe(true);
    expect(matchesQuery("auth: fix the redirect loop", "fix logout")).toBe(
      false,
    );
  });

  test("terms may match inside words", () => {
    expect(matchesQuery("c-a1b2", "a1b")).toBe(true);
  });

  test("collapses runs of whitespace between terms", () => {
    expect(matchesQuery("alpha beta", "alpha    beta")).toBe(true);
  });
});

describe("rowHaystack", () => {
  test("joins values with spaces so a query can span columns", () => {
    expect(rowHaystack(["a1b2c3d", "fix the loop", 7])).toBe(
      "a1b2c3d fix the loop 7",
    );
  });

  test("null and undefined become empty strings, not the literal words", () => {
    expect(rowHaystack([null, "x", undefined])).toBe(" x ");
    expect(rowHaystack([null])).not.toContain("null");
  });

  test("a zero survives — it is a value, not an absence", () => {
    expect(rowHaystack([0])).toBe("0");
  });
});

describe("sortGlyph", () => {
  test("shows direction when sorted and a neutral toggle when not", () => {
    expect(sortGlyph("asc")).toBe("↑");
    expect(sortGlyph("desc")).toBe("↓");
    expect(sortGlyph(false)).toBe("↕");
  });
});

describe("sortStateLabel", () => {
  test("describes the current state, not the next click", () => {
    expect(sortStateLabel("date", "asc")).toBe("date, sorted ascending");
    expect(sortStateLabel("date", "desc")).toBe("date, sorted descending");
    expect(sortStateLabel("date", false)).toBe("Sort by date");
  });
});

describe("hiddenColumnState", () => {
  test("maps every id to false", () => {
    expect(hiddenColumnState(["author", "sha"])).toEqual({
      author: false,
      sha: false,
    });
  });

  test("no ids means no overrides", () => {
    expect(hiddenColumnState([])).toEqual({});
  });
});

/**
 * The markup assertions below are the real contract. styles.css is global and
 * class-driven, so the emitted element names and class strings ARE the styling;
 * a stray wrapper span around a cell would silently restyle three lists.
 */
type Commit = { sha: string; subject: string; author: string; date: string };

const commits: Commit[] = [
  { sha: "b2c3d4e5f6", subject: "fix redirect", author: "rae", date: "2026-02-01" },
  { sha: "a1b2c3d4e5", subject: "add parser", author: "kim", date: "2026-01-01" },
];

const commitColumns: DataTableColumn<Commit>[] = [
  {
    id: "sha",
    accessorFn: (c) => c.sha,
    cell: (ctx) => (
      <code className="kb-history-sha">{ctx.row.original.sha.slice(0, 7)}</code>
    ),
  },
  {
    id: "subject",
    header: "subject",
    accessorFn: (c) => c.subject,
    cell: (ctx) => (
      <span className="kb-history-subj">{ctx.row.original.subject}</span>
    ),
  },
  {
    id: "date",
    header: "date",
    accessorFn: (c) => c.date,
    cell: (ctx) => (
      <span className="kb-muted">
        {ctx.row.original.author} · {ctx.row.original.date.slice(0, 10)}
      </span>
    ),
  },
];

const commitTable = (extra: Partial<Parameters<typeof DataTable<Commit>>[0]> = {}) =>
  html(
    <DataTable
      data={commits}
      columns={commitColumns}
      listClassName="kb-history-list"
      getRowId={(c) => c.sha}
      rowTestId="history-entry"
      {...extra}
    />,
  );

describe("DataTable rows", () => {
  test("emits the exact <li> markup the hand-written history list did", () => {
    expect(commitTable()).toContain(
      '<li data-testid="history-entry">' +
        '<code class="kb-history-sha">b2c3d4e</code>' +
        '<span class="kb-history-subj">fix redirect</span>' +
        '<span class="kb-muted">rae · 2026-02-01</span></li>',
    );
  });

  test("cells are direct children — no wrapper element per cell", () => {
    // .kb-history-list li is `flex-direction: column`; a wrapper would collapse
    // the three cells into one flex child and destroy the stacked layout.
    expect(commitTable()).not.toContain("</code></span>");
  });

  test("keeps source order on first paint — sorting starts empty", () => {
    const out = commitTable();
    expect(out.indexOf("b2c3d4e")).toBeLessThan(out.indexOf("a1b2c3d"));
  });

  test("puts the list class and testId on the <ul>", () => {
    expect(commitTable({ testId: "board-history-list" })).toContain(
      '<ul class="kb-history-list" data-testid="board-history-list">',
    );
  });

  test("omits data-testid on rows that never had one", () => {
    expect(commitTable({ rowTestId: undefined })).toContain("<li>");
  });

  test("rowClassName drives the disclosure list's is-open state", () => {
    expect(
      commitTable({ rowClassName: (c) => (c.author === "kim" ? "is-open" : undefined) }),
    ).toContain('<li class="is-open"');
  });

  test("renderRow takes over the <li> for rows that are not cell-shaped", () => {
    const out = commitTable({
      renderRow: (c) => <button type="button" className="kb-disclose-row">{c.subject}</button>,
    });
    expect(out).toContain('<button type="button" class="kb-disclose-row">fix redirect</button>');
    expect(out).not.toContain("kb-history-sha");
  });

  test("an empty list still renders the <ul>, matching the credentials pane", () => {
    expect(
      html(
        <DataTable
          data={[] as Commit[]}
          columns={commitColumns}
          listClassName="kb-disclose-list"
          getRowId={(c) => c.sha}
        />,
      ),
    ).toBe('<ul class="kb-disclose-list"></ul>');
  });
});

describe("DataTable toolbar", () => {
  test("no toolbar unless one is asked for", () => {
    expect(commitTable()).not.toContain("kb-datatable-toolbar");
  });

  test("a sort strip lists only columns that declare a header", () => {
    const out = commitTable({ sortLabel: "Sort commits", testId: "detail-history" });
    expect(out).toContain('<div class="kb-datatable-sort" role="group" aria-label="Sort commits">');
    expect(out).toContain('data-testid="detail-history-sort-subject"');
    expect(out).toContain('data-testid="detail-history-sort-date"');
    // "sha" has no header, so it stays out of the strip (but stays searchable).
    expect(out).not.toContain("-sort-sha");
  });

  test("sort buttons start unpressed and neutral", () => {
    const out = commitTable({ sortLabel: "Sort commits" });
    expect(out).toContain('aria-pressed="false" aria-label="Sort by subject"');
    expect(out).toContain("↕");
  });

  test("the filter box carries an accessible name and its testid", () => {
    expect(
      commitTable({ filterPlaceholder: "Search commits…", filterTestId: "history-filter" }),
    ).toContain(
      '<input class="kb-datatable-filter" type="search" placeholder="Search commits…" aria-label="Search commits…" data-testid="history-filter" value=""/>',
    );
  });

  test("a single row gets no toolbar — sorting one commit is noise", () => {
    expect(
      html(
        <DataTable
          data={[commits[0] as Commit]}
          columns={commitColumns}
          listClassName="kb-history-list"
          getRowId={(c) => c.sha}
          sortLabel="Sort commits"
          filterPlaceholder="Search…"
        />,
      ),
    ).not.toContain("kb-datatable-toolbar");
  });

  test("hidden columns stay out of the rendered cells", () => {
    const withAuthor: DataTableColumn<Commit>[] = [
      ...commitColumns,
      { id: "author", header: "author", accessorFn: (c) => c.author },
    ];
    const out = html(
      <DataTable
        data={commits}
        columns={withAuthor}
        listClassName="kb-history-list"
        getRowId={(c) => c.sha}
        hiddenColumns={["author"]}
        sortLabel="Sort commits"
        testId="detail-history"
      />,
    );
    // Present in the sort strip…
    expect(out).toContain('data-testid="detail-history-sort-author"');
    // …but contributing no cell of its own to the row.
    expect(out).toContain(
      '<span class="kb-muted">rae · 2026-02-01</span></li>',
    );
  });
});
