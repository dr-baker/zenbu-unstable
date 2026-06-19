import { useEffect, useRef, useState, type ReactNode } from "react"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@zenbu/ui/context-menu"
import { cn } from "@/lib/utils"
import { HoverTip } from "@zenbu/ui/hover-tip"
import { Spinner } from "../common/spinner"

export type ChatTabsAdjacency = {
  leftAdjacent?: boolean
  rightAdjacent?: boolean
}

export type ChatTabEntry = {
  id: string
  /** Display label, already truncated by the caller. */
  title: string
  hasChat: boolean
  sessionId?: string | null
  /** When true, the tab renders a small spinner to indicate the
   * underlying session is currently streaming / running. Mirrors the
   * spinner shown in the agent sidebar rows. */
  isStreaming?: boolean
  /** When true, render an unread dot on the tab. Used in the same
   * spirit as the sidebar row: the agent finished a turn while the
   * user wasn't viewing this tab. The owning container computes
   * this from `session.lastCompletedAt > (session.lastOpenedAt ?? 0)`
   * and gates it on "this tab is NOT the active one in a focused
   * pane" — `SessionActivityService` will clear the unread the
   * moment the user focuses the tab. */
  hasUnread?: boolean
  /** When true the tab is hosting a registered view (file-tree, pr,
   * etc.) rather than a chat. The tabstrip uses this to skip
   * chat-specific affordances. */
  isView?: boolean
}

export type ChatTabsProps = {
  entries: ChatTabEntry[]
  activeId: string
  /** "minimal" hides the strip-edge chrome (back/forward, +, split)
   * but keeps the tabs themselves rendered so right-click still
   * works \u2014 used when the host has exactly one pane with exactly
   * one tab so we don't expose tab UI before the user opts in.
   * "full" shows everything. */
  mode: "minimal" | "full"
  /** When false, no tab in this strip is rendered with the
   * "active" highlight \u2014 used so that in a split layout only the
   * focused pane shows an active tab. Defaults to true. */
  paneFocused?: boolean
  onSelect: (id: string) => void
  onClose: (id: string) => void
  /** Optional. When omitted, the "New tab" context menu item and
   * the strip-edge "+" button are hidden. Used by surfaces that
   * don't have a notion of "new tab" (e.g. the standalone
   * chat-window view). */
  onNewTab?: () => void
  /** Optional. When omitted, the "Split right" context menu item and
   * the strip-edge split button are hidden. Used by surfaces with no
   * pane concept. */
  onSplitRight?: () => void
  /** Optional. When omitted, the "Open in new tab" context menu item
   * is hidden. Receives the entry id so the host can resolve it back
   * to a chat. Skipped automatically for empty tabs (`hasChat`=false)
   * since there's nothing to duplicate. */
  onOpenInNewTab?: (entryId: string) => void
  /** Optional. When omitted, the "Close pane" context menu item is
   * hidden. The UI never deletes the last pane on surfaces that *do*
   * have panes (see project rules / pane state invariants); pass
   * `canClosePane=false` to grey it out instead of hiding it. */
  onClosePane?: () => void
  canClosePane?: boolean
} & ChatTabsAdjacency

/** Horizontal tab strip rendered at the top of a chat pane. Layout
 * borrows Zed's: scrollable tabs in the middle, "+" view-menu and
 * split button flush right. Right-click on
 * any tab opens a context menu (new tab, split, close). In
 * `mode="minimal"` the strip-edge affordances are hidden but the tab
 * itself stays so the right-click menu remains discoverable \u2014 used
 * for the single-pane / single-tab case. */
export function ChatTabs({
  entries,
  activeId,
  mode,
  onSelect,
  onClose,
  onNewTab,
  onSplitRight,
  onClosePane,
  onOpenInNewTab,
  canClosePane,
  paneFocused = true,
  leftAdjacent = false,
  rightAdjacent = false,
}: ChatTabsProps) {
  const minimal = mode === "minimal"
  const showNewTab = !!onNewTab
  const showSplit = !!onSplitRight
  const showOpenInNewTab = !!onOpenInNewTab
  const showClosePane = !!onClosePane
  const showNewTabButton = !minimal && showNewTab
  const showSplitButton = !minimal && showSplit

  // Track right-side overflow on the scrollable tabs container so
  // we can draw the cluster separator only when needed: when tabs
  // don't overflow (or we've scrolled all the way right), the
  // rightmost tab's own `border-r` sits flush against the action
  // cluster, so the cluster's `border-l` would render as a doubled
  // 2px line.
  const tabsScrollRef = useRef<HTMLDivElement | null>(null)
  const [overflowRight, setOverflowRight] = useState(false)
  useEffect(() => {
    const el = tabsScrollRef.current
    if (!el) return
    const measure = () => {
      const maxScroll = el.scrollWidth - el.clientWidth
      // Sub-pixel guard — fractional-DPR layouts leave ~0.5px of
      // residual scroll even when visually flush.
      setOverflowRight(maxScroll - el.scrollLeft > 0.5)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    // Each child changes the scrollWidth, so observe them too.
    for (const child of Array.from(el.children)) ro.observe(child)
    el.addEventListener("scroll", measure, { passive: true })
    return () => {
      ro.disconnect()
      el.removeEventListener("scroll", measure)
    }
  }, [entries.length])
  // The bar owns the top edge of the framed chat area: it draws the
  // `border-t` that meets the title bar above. The bar background
  // matches `var(--sidebar)` so inactive tabs (which share that
  // color) blend into the strip and the active tab visually pops
  // forward in `var(--tab-active)`.
  return (
    <div
      className={cn(
        // The 1px bottom separator is drawn by each tab (and each
        // strip-edge button) individually so the active tab can
        // suppress it and visually merge with the pane below.
        "flex h-9 w-full shrink-0 items-stretch border-t bg-sidebar overflow-hidden",
        rightAdjacent ? null : "border-r",
      )}
      style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
    >
      <div
        ref={tabsScrollRef}
        className="flex min-w-0 flex-1 items-stretch overflow-x-auto"
      >
        {entries.map(entry => (
          <ChatTabItem
            key={entry.id}
            entry={entry}
            isActive={paneFocused && entry.id === activeId}
            minimal={minimal}
            showNewTab={showNewTab}
            showSplit={showSplit}
            showOpenInNewTab={showOpenInNewTab}
            showClosePane={showClosePane}
            canClosePane={canClosePane}
            onSelect={onSelect}
            onClose={onClose}
            onNewTab={onNewTab}
            onSplitRight={onSplitRight}
            onOpenInNewTab={onOpenInNewTab}
            onClosePane={onClosePane}
          />
        ))}
      </div>
      {(showNewTabButton || showSplitButton) && (
        // `border-l` only when there's content clipped past the
        // right edge of the scroller. When scrolled all the way
        // to the right (or tabs don't overflow), the last tab's
        // own `border-r` is the separator and adding ours would
        // double the line. See `overflowRight` above.
        <div
          className={cn(
            "flex shrink-0 items-stretch",
            overflowRight && "border-l",
          )}
        >
          {showNewTabButton && (
            <StripButton label="New tab" onClick={onNewTab}>
              <PlusIcon />
            </StripButton>
          )}
          {showSplitButton && (
            <StripButton label="Split right" onClick={onSplitRight}>
              <SplitIcon />
            </StripButton>
          )}
        </div>
      )}
    </div>
  )
}

type StripButtonProps = {
  label: string
  onClick?: () => void
  disabled?: boolean
  children: ReactNode
}

function StripButton({ label, onClick, disabled, children }: StripButtonProps) {
  return (
    <HoverTip label={label} setAriaLabel={false}>
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      disabled={disabled}
      className={cn(
        "hg-tab-strip-button flex h-full w-8 shrink-0 items-center justify-center",
        // Disabled icons use `--foreground-disabled` (defined in
        // main.css): a fully-opaque color one step above the tab-strip
        // background, so the icon reads as "present but inert" without
        // looking active. Do NOT use `opacity-*` or alpha on
        // `currentColor` (e.g. `text-muted-foreground/40`) here —
        // - `opacity-*` would also fade the
        //   `box-shadow: inset 0 -1px 0 0 var(--border)` rule that
        //   draws the strip's bottom line, making the border under
        //   disabled buttons look lighter than under active tabs.
        // - Alpha on `currentColor` makes the strokes translucent, and
        //   the arrow icons are built from a `<line>` + `<polyline>`
        //   that overlap at the arrow tip. Two translucent strokes
        //   would stack at that seam and produce a visibly darker dot.
        disabled
          ? "text-foreground-disabled"
          : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
      )}
    >
      {children}
    </button>
    </HoverTip>
  )
}

type ChatTabItemProps = {
  entry: ChatTabEntry
  isActive: boolean
  minimal: boolean
  showNewTab: boolean
  showSplit: boolean
  showOpenInNewTab: boolean
  showClosePane: boolean
  canClosePane?: boolean
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onNewTab?: () => void
  onSplitRight?: () => void
  onOpenInNewTab?: (entryId: string) => void
  onClosePane?: () => void
}

function ChatTabItem({
  entry,
  isActive,
  minimal,
  showNewTab,
  showSplit,
  showOpenInNewTab,
  showClosePane,
  canClosePane,
  onSelect,
  onClose,
  onNewTab,
  onSplitRight,
  onOpenInNewTab,
  onClosePane,
}: ChatTabItemProps): ReactNode {
  const liveTitle = entry.title

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          onClick={e => {
            if (e.button === 0) onSelect(entry.id)
          }}
          onAuxClick={e => {
            if (e.button === 1) {
              e.preventDefault()
              onClose(entry.id)
            }
          }}
          className={cn(
            // No `border-l` on the leading tab: the pane frame
            // already draws the left edge of the chat area (and
            // the strip's `border-t` carries across the full
            // width). Adding one here doubled up against the
            // frame's `border-l` on the leftmost tab.
            "hg-tab group relative flex h-full min-w-[120px] flex-1 basis-0 select-none items-center gap-1.5 border-r px-2 text-[12px]",
            isActive
              ? "is-active text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-left",
              !entry.hasChat && "italic",
            )}
            aria-label={liveTitle}
          >
            {liveTitle}
          </span>
          {entry.isStreaming && (
            <span
              className={cn(
                "flex shrink-0 items-center text-muted-foreground",
                !minimal && "group-hover:hidden",
              )}
            >
              <Spinner />
            </span>
          )}
          {entry.hasUnread && !entry.isStreaming && (
            // Unread dot: a turn finished on this session while the
            // user wasn't viewing this tab. Hidden on hover so it
            // doesn't fight the close button for the same slot, and
            // suppressed entirely while streaming because the
            // spinner already covers "something is happening".
            <span
              aria-label="Unread"
              className={cn(
                "flex shrink-0 items-center",
                !minimal && "group-hover:hidden",
              )}
            >
              <span className="block h-1.5 w-1.5 rounded-full bg-foreground" />
            </span>
          )}
          {!minimal && (
            <div
              className="pointer-events-none absolute inset-y-0 right-0 hidden items-center group-hover:flex"
              aria-hidden={false}
            >
              {/* Gradient fade so the label slides under the close
                  button instead of being clipped abruptly. Matches
                  the strategy used by SidebarRow.hoverActions. */}
              <div
                className="h-full w-6"
                style={{
                  background:
                    "linear-gradient(to right, transparent, var(--hg-tab-bg))",
                }}
              />
              <div
                className="pointer-events-auto flex h-full items-center pr-1.5"
                style={{ background: "var(--hg-tab-bg)" }}
              >
                <button
                  type="button"
                  onClick={e => {
                    e.stopPropagation()
                    onClose(entry.id)
                  }}
                  aria-label="Close tab"
                  className="grid size-5 place-items-center rounded text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
                >
                  <CloseIcon />
                </button>
              </div>
            </div>
          )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        {showNewTab && onNewTab && (
          <ContextMenuItem onSelect={onNewTab}>New tab</ContextMenuItem>
        )}
        {showOpenInNewTab && onOpenInNewTab && entry.hasChat && (
          <ContextMenuItem onSelect={() => onOpenInNewTab(entry.id)}>
            Open in new tab
          </ContextMenuItem>
        )}
        {showSplit && onSplitRight && (
          <ContextMenuItem onSelect={onSplitRight}>Split right</ContextMenuItem>
        )}
        {(showNewTab || showSplit || showOpenInNewTab) && (
          <ContextMenuSeparator />
        )}
        <ContextMenuItem onSelect={() => onClose(entry.id)}>
          Close tab
        </ContextMenuItem>
        {showClosePane && onClosePane && (
          <ContextMenuItem onSelect={onClosePane} disabled={!canClosePane}>
            Close pane
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  )
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "\u2026"
}

function PlusIcon(): ReactNode {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  )
}

function CloseIcon(): ReactNode {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  )
}

function SplitIcon(): ReactNode {
  // Two side-by-side panes \u2014 mirrors the Zed split affordance.
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3" y="4" width="18" height="16" rx="1.5" />
      <line x1="12" y1="4" x2="12" y2="20" />
    </svg>
  )
}
