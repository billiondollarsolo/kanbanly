import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { IconButton, SegmentedControl, ToolbarButton } from "./Button.tsx";

/**
 * These assert the *emitted markup*, not behaviour: styles.css matches on the
 * exact kb-* class strings and the tests/browser checks match on data-testid,
 * so a drifted class name or a dropped passthrough is the failure mode worth
 * catching. The expected strings are copied from Board.tsx's inline markup.
 */

describe("IconButton", () => {
  test("emits the bare kb-icon-btn with passthrough attributes", () => {
    // Board.tsx:3002-3011 (bulk archive).
    expect(
      renderToStaticMarkup(
        <IconButton data-testid="bulk-archive" disabled title="Archive 2 selected">
          ⌫
        </IconButton>,
      ),
    ).toBe(
      '<button type="button" class="kb-icon-btn" data-testid="bulk-archive" disabled="" title="Archive 2 selected">⌫</button>',
    );
  });

  test("appends extra classes after the base class", () => {
    // Board.tsx:3017-3019 (alerts bell, quiet variant).
    const html = renderToStaticMarkup(
      <IconButton className="kb-alerts-btn is-quiet" data-testid="alerts-toggle" />,
    );
    expect(html).toContain('class="kb-icon-btn kb-alerts-btn is-quiet"');
  });

  test("omits the extra-class slot entirely when unset", () => {
    expect(renderToStaticMarkup(<IconButton />)).toContain('class="kb-icon-btn"');
  });

  test("forwards aria-expanded and arbitrary data-* attributes", () => {
    // Board.tsx:3092-3102 (theme cycler) carries data-theme-pref.
    const html = renderToStaticMarkup(
      <IconButton data-testid="theme-select" data-theme-pref="dark" aria-expanded={false}>
        <span data-testid="theme-dark">☾</span>
      </IconButton>,
    );
    expect(html).toContain('data-theme-pref="dark"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('<span data-testid="theme-dark">☾</span>');
  });
});

describe("ToolbarButton", () => {
  test("is kb-toolbar-btn with no modifier by default", () => {
    // Board.tsx:2945-2961 (Notes).
    expect(
      renderToStaticMarkup(
        <ToolbarButton data-testid="board-notes-open" title="Project notes (NOTES.md)">
          Notes
        </ToolbarButton>,
      ),
    ).toBe(
      '<button type="button" class="kb-toolbar-btn" data-testid="board-notes-open" title="Project notes (NOTES.md)">Notes</button>',
    );
  });

  test("on=true adds is-on, matching the Projects toggle template", () => {
    // Board.tsx:2903 -> `kb-toolbar-btn${showPortfolio ? " is-on" : ""}`.
    expect(
      renderToStaticMarkup(<ToolbarButton on data-testid="portfolio-open">Projects</ToolbarButton>),
    ).toContain('class="kb-toolbar-btn is-on"');
  });

  test("on=false is byte-identical to omitting it", () => {
    const off = renderToStaticMarkup(<ToolbarButton on={false}>x</ToolbarButton>);
    expect(off).toBe(renderToStaticMarkup(<ToolbarButton>x</ToolbarButton>));
    expect(off).toContain('class="kb-toolbar-btn"');
  });

  test("extra classes sit between the base class and is-on", () => {
    expect(
      renderToStaticMarkup(
        <ToolbarButton on className="kb-extra">
          x
        </ToolbarButton>,
      ),
    ).toContain('class="kb-toolbar-btn kb-extra is-on"');
  });
});

describe("SegmentedControl", () => {
  const priority = [
    { value: "", label: "all", key: "all", testId: "priority-filter-all" },
    { value: "P0", label: "P0", testId: "priority-filter-P0" },
    { value: "P1", label: "P1", testId: "priority-filter-P1" },
  ] as const;

  test("reproduces the priority filter markup (is-on marker)", () => {
    // Board.tsx:2925-2942.
    expect(
      renderToStaticMarkup(
        <SegmentedControl
          className="kb-priority-seg"
          label="Priority filter"
          testId="priority-filter"
          items={priority}
          value="P0"
          onChange={() => {}}
        />,
      ),
    ).toBe(
      '<div class="kb-priority-seg" role="group" aria-label="Priority filter" data-testid="priority-filter">' +
        '<button type="button" data-testid="priority-filter-all">all</button>' +
        '<button type="button" class="is-on" data-testid="priority-filter-P0">P0</button>' +
        '<button type="button" data-testid="priority-filter-P1">P1</button>' +
        "</div>",
    );
  });

  test("inactive segments carry no class attribute at all", () => {
    const html = renderToStaticMarkup(
      <SegmentedControl
        className="kb-priority-seg"
        label="Priority filter"
        items={priority}
        value=""
        onChange={() => {}}
      />,
    );
    // Exactly one active segment, and it is the empty-string ("all") one.
    expect(html.match(/class="is-on"/g)?.length).toBe(1);
    expect(html).toContain('<button type="button" class="is-on" data-testid="priority-filter-all">');
  });

  test("omits data-testid on the container when no testId is given", () => {
    // Board.tsx:4286 (kb-seg-row) has an aria-label but no testid.
    const html = renderToStaticMarkup(
      <SegmentedControl
        className="kb-seg-row"
        label="Repository source"
        items={[
          { value: "existing", label: "Existing repo", disabled: true },
          { value: "new", label: "New / enter repo" },
        ]}
        value="new"
        onChange={() => {}}
      />,
    );
    expect(html).toBe(
      '<div class="kb-seg-row" role="group" aria-label="Repository source">' +
        '<button type="button" disabled="">Existing repo</button>' +
        '<button type="button" class="is-on">New / enter repo</button>' +
        "</div>",
    );
  });

  test("aria-pressed marker sets the attribute on every segment and no class", () => {
    // Board.tsx:4939-4956 (theme switch).
    expect(
      renderToStaticMarkup(
        <SegmentedControl
          className="kb-theme-switch"
          label="Theme"
          marker="aria-pressed"
          items={[
            { value: "light", label: "light" },
            { value: "dark", label: "dark" },
            { value: "system", label: "auto" },
          ]}
          value="dark"
          onChange={() => {}}
        />,
      ),
    ).toBe(
      '<div class="kb-theme-switch" role="group" aria-label="Theme">' +
        '<button type="button" aria-pressed="false">light</button>' +
        '<button type="button" aria-pressed="true">dark</button>' +
        '<button type="button" aria-pressed="false">auto</button>' +
        "</div>",
    );
  });

  test("the two markers never leak into each other", () => {
    const items = [{ value: "a", label: "a" }] as const;
    const pressed = renderToStaticMarkup(
      <SegmentedControl
        className="kb-theme-switch"
        label="T"
        marker="aria-pressed"
        items={items}
        value="a"
        onChange={() => {}}
      />,
    );
    expect(pressed).not.toContain("is-on");

    const on = renderToStaticMarkup(
      <SegmentedControl
        className="kb-priority-seg"
        label="T"
        items={items}
        value="a"
        onChange={() => {}}
      />,
    );
    expect(on).not.toContain("aria-pressed");
  });
});
