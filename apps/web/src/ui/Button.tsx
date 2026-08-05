/**
 * Button primitives for the kb-* design system.
 *
 * These are thin wrappers: they own the class-name composition and nothing
 * else, so `styles.css` keeps styling them exactly as it styles the inline
 * markup they replace. Every prop that is not consumed here is forwarded to the
 * underlying <button>, which is how `data-testid`, `title`, `aria-*`,
 * `disabled` and `onClick` keep working unchanged.
 *
 * Three shapes live here:
 *   IconButton       — the square glyph button (.kb-icon-btn, --control-h box)
 *   ToolbarButton    — the uppercase mono pill (.kb-toolbar-btn, + .is-on)
 *   SegmentedControl — a bordered strip of buttons where exactly one is active
 */

import type { ButtonHTMLAttributes, ReactNode } from "react";

/** Join class names, dropping falsy entries. Keeps the emitted string exact. */
function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/**
 * Native button props minus the two we compose ourselves. `type` is pinned to
 * "button" because every call site in the app is a non-submitting button, and a
 * stray submit inside one of the settings forms would post the page.
 */
type NativeButtonProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "className" | "type"
>;

export type IconButtonProps = NativeButtonProps & {
  /**
   * Extra classes appended after `kb-icon-btn`, e.g. `"kb-alerts-btn is-quiet"`.
   * The base class always comes first so the emitted string matches the markup
   * this replaces.
   */
  className?: string;
  "data-testid"?: string;
  children?: ReactNode;
};

/**
 * The 30px square icon button (`--control-h` in styles.css:453).
 *
 * Emits `<button type="button" class="kb-icon-btn …">`. Used for bulk-archive,
 * the alerts bell, the theme cycler, settings and help.
 */
export function IconButton({ className, children, ...rest }: IconButtonProps) {
  return (
    <button type="button" className={cx("kb-icon-btn", className)} {...rest}>
      {children}
    </button>
  );
}

export type ToolbarButtonProps = NativeButtonProps & {
  /** Renders the `.is-on` active state (styles.css:545). */
  on?: boolean;
  /** Extra classes, appended between the base class and `is-on`. */
  className?: string;
  "data-testid"?: string;
  children?: ReactNode;
};

/**
 * The uppercase monospace toolbar/action button (styles.css:516).
 *
 * `on` reproduces the `` `kb-toolbar-btn${x ? " is-on" : ""}` `` template that
 * the Projects toggle uses.
 */
export function ToolbarButton({
  on,
  className,
  children,
  ...rest
}: ToolbarButtonProps) {
  return (
    <button
      type="button"
      className={cx("kb-toolbar-btn", className, on && "is-on")}
      {...rest}
    >
      {children}
    </button>
  );
}

/**
 * How a segment signals that it is the selected one.
 *
 * The three call sites genuinely differ — `kb-priority-seg` and `kb-seg-row`
 * style `button.is-on`, while `kb-theme-switch` styles
 * `button[aria-pressed="true"]` — so the marker is explicit rather than
 * guessed. Both invert to `background: var(--fg); color: var(--bg)`.
 */
export type SegmentedMarker = "is-on" | "aria-pressed";

export type SegmentedItem<T extends string> = {
  value: T;
  label: ReactNode;
  /** React key; defaults to `value`. Set it when a value is the empty string. */
  key?: string;
  /** Becomes `data-testid` on the segment. */
  testId?: string;
  disabled?: boolean;
  title?: string;
};

export type SegmentedControlProps<T extends string> = {
  /**
   * The container class: `kb-priority-seg`, `kb-theme-switch` or `kb-seg-row`.
   * It carries the border, the rounding and the overflow clipping, so the
   * segments themselves stay borderless except for their right divider.
   */
  className: string;
  /** `aria-label` on the role="group" container. */
  label: string;
  items: ReadonlyArray<SegmentedItem<T>>;
  /** The currently selected value; matched against `item.value`. */
  value: T;
  onChange: (value: T) => void;
  /** Defaults to `"is-on"`, the majority convention. */
  marker?: SegmentedMarker;
  /** `data-testid` on the container. */
  testId?: string;
};

/**
 * A bordered strip of buttons where exactly one is active.
 *
 * The container is `role="group"` (matching all three existing sites) and each
 * segment is a plain `<button type="button">` with no class of its own — the
 * strip's CSS selects them by descendant selector.
 */
export function SegmentedControl<T extends string>({
  className,
  label,
  items,
  value,
  onChange,
  marker = "is-on",
  testId,
}: SegmentedControlProps<T>) {
  return (
    <div
      className={className}
      role="group"
      aria-label={label}
      data-testid={testId}
    >
      {items.map((item) => {
        const active = item.value === value;
        return (
          <button
            key={item.key ?? item.value}
            type="button"
            className={marker === "is-on" && active ? "is-on" : undefined}
            aria-pressed={marker === "aria-pressed" ? active : undefined}
            data-testid={item.testId}
            disabled={item.disabled}
            title={item.title}
            onClick={() => onChange(item.value)}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
