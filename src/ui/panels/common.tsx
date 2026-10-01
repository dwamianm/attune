/**
 * Building blocks shared by every panel: the compact summary tile, toolbars,
 * filter chips, pills, buttons, selectable rows, and the hero list/detail
 * split. Keeping them here makes the ten panels look like one product.
 */
import clsx from "clsx";
import { Search, X, type LucideIcon } from "lucide-react";
import type { ButtonHTMLAttributes, ReactNode, Ref } from "react";
import type { ItemKind, PanelSize } from "../../../shared/types.ts";
import { STEP_ACTION_ATTR } from "../domHooks.ts";
import { useRovingList } from "../hooks.ts";
import { useItemProps } from "../linking.tsx";

export interface PanelProps {
  size: PanelSize;
}

export type Tone = "good" | "warn" | "bad" | "neutral" | "accent";

const PILL_TONE: Record<Tone, string> = {
  good: "bg-good-soft text-good-ink",
  warn: "bg-warn-soft text-warn-ink",
  bad: "bg-bad-soft text-bad-ink",
  neutral: "bg-surface-3 text-ink-2",
  accent: "bg-accent-soft text-accent-text",
};

const DOT_TONE: Record<Tone, string> = {
  good: "bg-good",
  warn: "bg-warn",
  bad: "bg-bad",
  neutral: "bg-ink-3",
  accent: "bg-accent",
};

export function Pill({ tone, children, className }: { tone: Tone; children: ReactNode; className?: string }) {
  return (
    <span
      className={clsx(
        "inline-flex h-5 shrink-0 items-center rounded-full px-2 text-2xs font-medium whitespace-nowrap",
        PILL_TONE[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/** A colored dot. `label` is read by screen readers since color alone carries no meaning for them. */
export function Dot({ tone, label, className }: { tone: Tone; label?: string; className?: string }) {
  return (
    <span className={clsx("inline-block size-2 shrink-0 rounded-full", DOT_TONE[tone], className)} aria-hidden={label ? undefined : true}>
      {label ? <span className="sr-only">{label}</span> : null}
    </span>
  );
}

type ButtonVariant = "primary" | "secondary" | "ghost";

export function Button({
  variant = "secondary",
  size = "sm",
  icon: Icon,
  className,
  children,
  type = "button",
  step = false,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: "xs" | "sm" | "md";
  icon?: LucideIcon;
  /** The next step's suggestion would press this button (useStepAction): a soft ring in the link color, so the eye finds it. */
  step?: boolean;
}) {
  return (
    <button
      type={type}
      {...(step ? { [STEP_ACTION_ATTR]: "" } : {})}
      className={clsx(
        "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg font-medium whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        size === "xs" && "h-6 px-2 text-2xs",
        size === "sm" && "h-7 px-2.5 text-xs",
        size === "md" && "h-8 px-3 text-sm",
        variant === "primary" && "bg-accent text-accent-fg hover:bg-accent-hover",
        variant === "secondary" && "border border-line bg-surface text-ink hover:bg-surface-2",
        variant === "ghost" && "text-ink-2 hover:bg-surface-2 hover:text-ink",
        step && "ring-2 ring-link/55 ring-offset-1 ring-offset-surface",
        className,
      )}
      {...rest}
    >
      {Icon ? <Icon className={size === "md" ? "size-4" : "size-3.5"} aria-hidden /> : null}
      {children}
    </button>
  );
}

/**
 * The compact view: one key number plus a one-line summary. Compact tiles are
 * one grid unit tall, so this is a single row under the panel header.
 */
export function Compact({ value, label, sub }: { value: ReactNode; label?: ReactNode; sub?: ReactNode }) {
  return (
    <div className="fl-pad flex h-full min-w-0 items-center pb-3">
      <div className="flex min-w-0 flex-1 items-baseline gap-2">
        <span className="text-2xl leading-none font-semibold tracking-tight text-ink">{value}</span>
        {label ? <span className="shrink-0 text-sm text-ink-2">{label}</span> : null}
        {sub ? (
          <>
            <span className="text-ink-3" aria-hidden>
              ·
            </span>
            <span className="min-w-0 truncate text-sm text-ink-3">{sub}</span>
          </>
        ) : null}
      </div>
    </div>
  );
}

/** Full-height column: fixed toolbar on top, scrolling list below. */
export function PanelColumn({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={clsx("flex h-full min-h-0 flex-col", className)}>{children}</div>;
}

export function Toolbar({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={clsx("fl-pad flex shrink-0 items-center gap-2 pb-2", className)}>{children}</div>;
}

export function SearchField({
  value,
  onChange,
  placeholder,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  label: string;
}) {
  return (
    <label className="relative flex h-7 min-w-0 flex-1 items-center">
      <span className="sr-only">{label}</span>
      <Search className="pointer-events-none absolute left-2 size-3.5 text-ink-3" aria-hidden />
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-7 w-full min-w-0 rounded-lg border border-line bg-surface-2 pr-7 pl-7 text-xs text-ink placeholder:text-ink-3 focus:border-accent focus:bg-surface focus:outline-none"
      />
      {value ? (
        <button
          type="button"
          onClick={() => onChange("")}
          className="absolute right-1 grid size-5 place-items-center rounded-md text-ink-3 hover:bg-surface-3 hover:text-ink"
          aria-label={`Clear ${label.toLowerCase()}`}
        >
          <X className="size-3" aria-hidden />
        </button>
      ) : null}
    </label>
  );
}

/** A row of mutually exclusive options (tabs or filter chips). */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  className,
}: {
  options: { id: T; label: string }[];
  value: T;
  onChange: (id: T) => void;
  label: string;
  className?: string;
}) {
  return (
    <div role="group" aria-label={label} className={clsx("fl-scroll flex min-w-0 items-center gap-1 overflow-x-auto", className)}>
      {options.map((o) => {
        const active = o.id === value;
        return (
          <button
            key={o.id}
            type="button"
            aria-pressed={active}
            onClick={() => {
              if (!active) onChange(o.id);
            }}
            className={clsx(
              "h-6 shrink-0 rounded-md px-2 text-2xs font-medium whitespace-nowrap transition-colors",
              active ? "bg-accent-soft text-accent-text" : "text-ink-2 hover:bg-surface-2 hover:text-ink",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** Shows an active client filter set by a command or suggestion, with a clear button. */
export function ClientFilterChip({ client, onClear }: { client: string; onClear: () => void }) {
  return (
    <div className="fl-pad shrink-0 pb-2">
      <span className="inline-flex h-6 max-w-full items-center gap-1 rounded-full border border-accent/30 bg-accent-soft pr-0.5 pl-2.5 text-2xs text-accent-text">
        <span className="truncate">
          Client: <span className="font-medium">{client}</span>
        </span>
        <button
          type="button"
          onClick={onClear}
          className="grid size-5 shrink-0 place-items-center rounded-full hover:bg-accent/15"
          aria-label={`Clear client filter ${client}`}
        >
          <X className="size-3" aria-hidden />
        </button>
      </span>
    </div>
  );
}

/** A scrolling list that is one Tab stop; arrow keys move between rows (see useRovingList). */
export function ListScroll({ children, label, className }: { children: ReactNode; label: string; className?: string }) {
  const roving = useRovingList<HTMLUListElement>();
  return (
    <ul
      ref={roving.ref}
      onKeyDown={roving.onKeyDown}
      onFocus={roving.onFocus}
      aria-label={label}
      className={clsx("fl-scroll min-h-0 flex-1 overflow-y-auto pb-1.5", className)}
    >
      {children}
    </ul>
  );
}

/**
 * A selectable list row. The whole row is a real button for keyboard use.
 * `item` names the record it shows, for the link tint and the DOM hooks.
 */
export function RowButton({
  selected,
  onClick,
  children,
  className,
  ref,
  label,
  item,
}: {
  selected: boolean;
  onClick: () => void;
  children: ReactNode;
  className?: string;
  ref?: Ref<HTMLButtonElement>;
  label?: string;
  item?: { kind: ItemKind; id: string };
}) {
  const itemProps = useItemProps();
  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      {...(item ? itemProps(item.kind, item.id) : {})}
      data-roving
      aria-current={selected ? "true" : undefined}
      aria-label={label}
      className={clsx(
        "fl-row fl-pad relative flex w-full min-w-0 items-start gap-2.5 text-left transition-colors",
        selected ? "bg-accent-soft/70" : "hover:bg-surface-2",
        className,
      )}
    >
      {selected ? <span className="fl-select-bar absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-accent" aria-hidden /> : null}
      {children}
    </button>
  );
}

export function EmptyList({ children }: { children: ReactNode }) {
  return <p className="fl-pad py-6 text-center text-xs text-ink-3">{children}</p>;
}

/**
 * The body of every list panel at standard and hero size. At hero size the
 * detail sits beside the list when the card is wide enough, and below it when
 * it is not (phones), using a container query on the card body.
 *
 * The list is always the first child of the same wrappers, whatever the size,
 * so React keeps it mounted when a panel grows or shrinks. Returning a bare
 * list at standard size and a split at hero size remounted the list, and a
 * search field lost focus (and the next keystrokes) mid-word.
 */
export function HeroSplit({ list, detail, hero = true }: { list: ReactNode; detail?: ReactNode; hero?: boolean }) {
  return (
    <div className="@container h-full min-h-0">
      <div
        className={clsx(
          "grid h-full min-h-0",
          hero ? "grid-rows-[minmax(0,1fr)_minmax(0,1fr)] @lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] @lg:grid-rows-1" : "grid-rows-[minmax(0,1fr)]",
        )}
      >
        <div className="min-h-0 min-w-0">{list}</div>
        {hero ? <div className="min-h-0 min-w-0 border-t border-line @lg:border-t-0 @lg:border-l">{detail}</div> : null}
      </div>
    </div>
  );
}

/** Scrolling detail pane for hero panels. */
export function DetailPane({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="fl-scroll fl-pad min-h-0 flex-1 overflow-y-auto pt-2 pb-3">{children}</div>
      {actions ? <div className="fl-pad flex shrink-0 flex-wrap items-center gap-2 border-t border-line py-2.5">{actions}</div> : null}
    </div>
  );
}

export function DetailEmpty({ icon: Icon, children }: { icon: LucideIcon; children: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center text-xs text-ink-3">
      <Icon className="size-5" aria-hidden />
      {children}
    </div>
  );
}

/** Label and value pairs in a detail pane. */
export function Facts({ items }: { items: { label: string; value: ReactNode }[] }) {
  return (
    <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-xs">
      {items.map((it) => (
        <div key={it.label} className="contents">
          <dt className="text-ink-3">{it.label}</dt>
          <dd className="min-w-0 truncate text-ink">{it.value}</dd>
        </div>
      ))}
    </dl>
  );
}
