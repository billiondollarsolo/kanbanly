import { useEffect, useRef, type ReactNode } from "react";

/**
 * Anchored dropdown panel shared by the board picker, the column menu and the
 * alerts menu.
 *
 * The three call sites already share their look through styles.css: the wrapper
 * class supplies `position: relative`, and the panel class supplies the
 * absolute placement, `--r-menu`, `--shadow-menu` and the `kb-pop` animation.
 * This component owns only the parts CSS cannot express — dismissal on outside
 * click and on Escape — and stays out of the way of the class names so
 * styles.css keeps applying unchanged.
 *
 * Open state stays with the consumer. Every call site already drives its panel
 * from a state flag that other code reads (the anchor's `aria-expanded`, sibling
 * menus closing each other), so owning it here would fight the existing wiring.
 */

/** The single DOM method the dismiss logic needs, so tests can pass a stub. */
type ContainsNode = { contains: (node: Node | null) => boolean };

/**
 * Whether a pointer event that landed on `target` should dismiss the panel.
 *
 * A missing root means the wrapper is not mounted yet; staying open is the safe
 * answer there, because a popover that closes before it has a position on the
 * page can never be interacted with.
 */
export function shouldDismissOnPointer(
  root: ContainsNode | null,
  target: EventTarget | null,
): boolean {
  if (!root) return false;
  return !root.contains(target as Node | null);
}

/** Whether a keydown should dismiss the panel. */
export function shouldDismissOnKey(key: string): boolean {
  return key === "Escape";
}

type PopoverProps = {
  /** Whether the panel is rendered. Owned by the consumer. */
  open: boolean;
  /**
   * Asked for by an outside click or Escape. The consumer closes itself.
   *
   * Optional, and its presence is what decides who owns dismissal. Supplied,
   * this component listens for an outside pointer press and Escape, and stops
   * panel clicks from reaching an app-level "click anywhere closes the menus"
   * handler — the three go together, because a panel that intercepts those
   * clicks while not dismissing itself could never be closed. Omitted, the
   * component is pure markup and the consumer keeps whatever dismissal wiring
   * it already has.
   */
  onClose?: () => void;
  /**
   * The trigger, rendered inside the positioning wrapper ahead of the panel.
   * Takes arbitrary nodes because the board picker puts a count badge next to
   * its button, inside the same wrapper.
   */
  anchor: ReactNode;
  /** Panel contents. */
  children: ReactNode;
  /** Wrapper class: `kb-col-menu-wrap`, `kb-board-picker`, `kb-alerts`. */
  className: string;
  /** Panel class: `kb-col-menu`, `kb-board-menu`, `kb-alerts-menu`. */
  panelClassName: string;
  /** Panel role — the call sites genuinely differ (menu/listbox/dialog). */
  role?: "menu" | "listbox" | "dialog";
  /** Accessible name for the panel. */
  ariaLabel?: string;
  /** data-testid for the wrapper. */
  testId?: string;
  /** data-testid for the panel. */
  panelTestId?: string;
};

export function Popover({
  open,
  onClose,
  anchor,
  children,
  className,
  panelClassName,
  role,
  ariaLabel,
  testId,
  panelTestId,
}: PopoverProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const managed = onClose !== undefined;

  // Held in a ref so the listeners subscribe once per open/close rather than on
  // every render an inline `onClose` arrow would cause.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open || !managed) return;

    // Capture phase: React attaches its handlers at the root container, so a
    // synthetic stopPropagation (including the panel's own, below) would stop
    // the native event before a bubble-phase document listener ever saw it.
    const onPointerDown = (e: MouseEvent) => {
      if (shouldDismissOnPointer(rootRef.current, e.target)) onCloseRef.current?.();
    };
    // Bubble phase, matching the card modal's Escape handling, so a field
    // inside the panel can still swallow Escape for its own purposes.
    const onKeyDown = (e: KeyboardEvent) => {
      if (shouldDismissOnKey(e.key)) onCloseRef.current?.();
    };

    document.addEventListener("mousedown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, managed]);

  return (
    <div ref={rootRef} className={className} data-testid={testId}>
      {anchor}
      {open ? (
        <div
          className={panelClassName}
          data-testid={panelTestId}
          role={role}
          aria-label={ariaLabel}
          // The app root carries a global "click anywhere closes the menus"
          // handler; a click inside the panel is not an outside click. Only
          // when this component owns dismissal, though — otherwise that handler
          // IS the dismissal and must keep seeing the click.
          onClick={managed ? (e) => e.stopPropagation() : undefined}
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}

type MenuItemProps = {
  onClick: () => void;
  children: ReactNode;
  /**
   * Full class string including any modifier. Left undefined for the column
   * menu, whose rows are styled by the `.kb-col-menu button` descendant
   * selector rather than a class of their own — emitting an empty class there
   * would change the rendered markup.
   */
  className?: string;
  role?: "menuitem" | "option";
  /** Rendered as `aria-selected`; only the listbox call site passes it. */
  selected?: boolean;
  disabled?: boolean;
  title?: string;
  testId?: string;
};

/**
 * A row inside a Popover panel.
 *
 * The three menus do not share a row class — the column menu has none at all,
 * and the board and alerts menus use different active modifiers (`is-active`
 * vs `is-acked`) — so the caller composes `className` and this component only
 * unifies the button scaffolding.
 */
export function MenuItem({
  onClick,
  children,
  className,
  role,
  selected,
  disabled,
  title,
  testId,
}: MenuItemProps) {
  return (
    <button
      type="button"
      className={className}
      role={role}
      aria-selected={selected}
      disabled={disabled}
      title={title}
      data-testid={testId}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
