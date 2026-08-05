import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  MenuItem,
  Popover,
  shouldDismissOnKey,
  shouldDismissOnPointer,
} from "./Popover.tsx";

/** Stand-in for the wrapper element, so the dismiss logic is testable without a DOM. */
function root(inside: unknown[]): { contains: (n: Node | null) => boolean } {
  return { contains: (n) => inside.includes(n) };
}

describe("shouldDismissOnPointer", () => {
  test("a click inside the wrapper keeps the panel open", () => {
    const node = {};
    expect(shouldDismissOnPointer(root([node]), node as EventTarget)).toBe(false);
  });

  test("a click anywhere else dismisses", () => {
    expect(shouldDismissOnPointer(root([{}]), {} as EventTarget)).toBe(true);
  });

  test("an unmounted wrapper never dismisses", () => {
    // Closing before the panel has a position on the page would make it
    // impossible to interact with.
    expect(shouldDismissOnPointer(null, {} as EventTarget)).toBe(false);
  });

  test("a null target counts as outside", () => {
    expect(shouldDismissOnPointer(root([]), null)).toBe(true);
  });
});

describe("shouldDismissOnKey", () => {
  test("Escape dismisses", () => {
    expect(shouldDismissOnKey("Escape")).toBe(true);
  });

  test("other keys do not", () => {
    for (const k of ["Enter", "Tab", " ", "Esc", "escape", "ArrowDown"]) {
      expect(shouldDismissOnKey(k)).toBe(false);
    }
  });
});

describe("Popover markup", () => {
  test("closed renders the wrapper and anchor but no panel", () => {
    const html = renderToStaticMarkup(
      <Popover
        open={false}
        onClose={() => {}}
        className="kb-col-menu-wrap"
        panelClassName="kb-col-menu"
        panelTestId="col-menu-panel-todo"
        anchor={<button type="button">···</button>}
      >
        <MenuItem onClick={() => {}}>Rename list</MenuItem>
      </Popover>,
    );
    expect(html).toContain('class="kb-col-menu-wrap"');
    expect(html).toContain("···");
    expect(html).not.toContain("kb-col-menu-panel");
    expect(html).not.toContain('class="kb-col-menu"');
    expect(html).not.toContain("Rename list");
  });

  test("column menu shape matches Board.tsx", () => {
    const html = renderToStaticMarkup(
      <Popover
        open
        onClose={() => {}}
        className="kb-col-menu-wrap"
        panelClassName="kb-col-menu"
        role="menu"
        panelTestId="col-menu-panel-todo"
        anchor={<button type="button">···</button>}
      >
        <MenuItem onClick={() => {}} role="menuitem" testId="col-rename-todo">
          Rename list
        </MenuItem>
        <MenuItem
          onClick={() => {}}
          role="menuitem"
          className="kb-col-menu-danger"
          testId="col-delete-todo"
        >
          Delete list…
        </MenuItem>
      </Popover>,
    );
    expect(html).toContain('class="kb-col-menu-wrap"');
    expect(html).toContain('class="kb-col-menu"');
    expect(html).toContain('role="menu"');
    expect(html).toContain('data-testid="col-menu-panel-todo"');
    expect(html).toContain('data-testid="col-rename-todo"');
    expect(html).toContain('class="kb-col-menu-danger"');
    // No wrapper testid at this call site, and none should be invented.
    expect(html).not.toContain('class="kb-col-menu-wrap" data-testid');
  });

  test("board picker shape keeps its wrapper testid and extra anchor sibling", () => {
    const html = renderToStaticMarkup(
      <Popover
        open
        onClose={() => {}}
        className="kb-board-picker"
        testId="board-picker"
        panelClassName="kb-board-menu"
        panelTestId="board-menu"
        role="listbox"
        ariaLabel="Boards"
        anchor={
          <>
            <button type="button" className="kb-board-picker-btn" />
            <span className="kb-card-count-badge">7</span>
          </>
        }
      >
        <MenuItem
          onClick={() => {}}
          role="option"
          selected
          className="kb-board-menu-item is-active"
          testId="board-menu-item-web"
        >
          web
        </MenuItem>
        <MenuItem
          onClick={() => {}}
          role="option"
          selected={false}
          className="kb-board-menu-item"
          testId="board-menu-item-api"
        >
          api
        </MenuItem>
      </Popover>,
    );
    expect(html).toContain('data-testid="board-picker"');
    expect(html).toContain('class="kb-board-menu"');
    expect(html).toContain('role="listbox"');
    expect(html).toContain('aria-label="Boards"');
    // The count badge sits between the trigger and the panel, inside the wrapper.
    expect(html.indexOf("kb-card-count-badge")).toBeLessThan(
      html.indexOf("kb-board-menu"),
    );
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('aria-selected="false"');
  });

  test("alerts shape renders a dialog panel", () => {
    const html = renderToStaticMarkup(
      <Popover
        open
        onClose={() => {}}
        className="kb-alerts"
        panelClassName="kb-alerts-menu"
        panelTestId="fleet-alerts"
        role="dialog"
        ariaLabel="Fleet alerts"
        anchor={<button type="button" className="kb-icon-btn kb-alerts-btn" />}
      >
        <MenuItem onClick={() => {}} className="kb-alerts-item is-acked">
          <span className="kb-alerts-board">web</span>
        </MenuItem>
      </Popover>,
    );
    expect(html).toContain('class="kb-alerts"');
    expect(html).toContain('class="kb-alerts-menu"');
    expect(html).toContain('role="dialog"');
    expect(html).toContain('data-testid="fleet-alerts"');
    expect(html).toContain('class="kb-alerts-item is-acked"');
  });
});

describe("Popover dismissal ownership", () => {
  // `onClose` is what decides who owns dismissal. The board's three menus omit
  // it because they are already dismissed by an app-root click handler, and
  // handing dismissal to this component would add Escape and in-header
  // dismissal they do not have today.
  test("omitting onClose changes no markup", () => {
    const shape = (extra: { onClose?: () => void }) =>
      renderToStaticMarkup(
        <Popover
          open
          className="kb-col-menu-wrap"
          panelClassName="kb-col-menu"
          panelTestId="col-menu-panel-todo"
          role="menu"
          anchor={<button type="button">···</button>}
          {...extra}
        >
          <MenuItem onClick={() => {}} role="menuitem">
            Rename list
          </MenuItem>
        </Popover>,
      );
    expect(shape({})).toBe(shape({ onClose: () => {} }));
  });

  test("an unmanaged popover still renders its panel when open", () => {
    const html = renderToStaticMarkup(
      <Popover
        open
        className="kb-alerts"
        panelClassName="kb-alerts-menu"
        panelTestId="fleet-alerts"
        anchor={<button type="button" />}
      >
        <span>needs attention</span>
      </Popover>,
    );
    expect(html).toContain('data-testid="fleet-alerts"');
    expect(html).toContain("needs attention");
  });
});

describe("MenuItem markup", () => {
  test("omits class entirely when no className is given", () => {
    // `.kb-col-menu button` styles the column menu's rows, so an empty class
    // attribute there would be a markup change with no styling behind it.
    const html = renderToStaticMarkup(
      <MenuItem onClick={() => {}} role="menuitem">
        Move left
      </MenuItem>,
    );
    expect(html).toBe('<button type="button" role="menuitem">Move left</button>');
  });

  test("omits aria-selected unless asked for", () => {
    const html = renderToStaticMarkup(<MenuItem onClick={() => {}}>x</MenuItem>);
    expect(html).not.toContain("aria-selected");
  });

  test("forwards disabled and title", () => {
    const html = renderToStaticMarkup(
      <MenuItem onClick={() => {}} disabled title="Cards on this board">
        x
      </MenuItem>,
    );
    expect(html).toContain("disabled");
    expect(html).toContain('title="Cards on this board"');
  });
});
