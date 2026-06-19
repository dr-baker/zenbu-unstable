import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { cn } from "@/lib/utils"
import { FileIcon } from "@/components/common/file-icon"
import type { FileEntry } from "./types"

export type FilePickerMenuProps = {
  options: FileEntry[]
  selectedIndex: number
  onSelect: (option: FileEntry) => void
  onHover: (index: number) => void
  /** Caret coordinate in viewport space. The menu opens above this point. */
  anchor: { left: number; top: number; bottom: number } | null
}

/** Fixed row height in px — must match the row's rendered height. */
const ROW_HEIGHT = 32
/** Max visible rows before scrolling. */
const MAX_VISIBLE = 8
/** Overscan rows above/below the viewport. */
const OVERSCAN = 3
/** Menu width in px. */
const MENU_WIDTH = 360

export function FilePickerMenu({
  options,
  selectedIndex,
  onSelect,
  onHover,
  anchor,
}: FilePickerMenuProps) {
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const [scrollTop, setScrollTop] = useState(0)

  // Scroll selected item into view.
  useLayoutEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    const top = selectedIndex * ROW_HEIGHT
    const bottom = top + ROW_HEIGHT
    if (top < el.scrollTop) {
      el.scrollTop = top
    } else if (bottom > el.scrollTop + el.clientHeight) {
      el.scrollTop = bottom - el.clientHeight
    }
  }, [selectedIndex])

  useEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    const onScroll = () => setScrollTop(el.scrollTop)
    el.addEventListener("scroll", onScroll, { passive: true })
    return () => el.removeEventListener("scroll", onScroll)
  }, [])

  if (options.length === 0) return null

  const visibleCount = Math.min(options.length, MAX_VISIBLE)
  const viewportHeight = visibleCount * ROW_HEIGHT
  const totalHeight = options.length * ROW_HEIGHT

  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN)
  const last = Math.min(
    options.length,
    Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN,
  )

  // Position: fixed to viewport so we can anchor to the caret regardless of
  // the composer's containing block. Open upwards so the caret stays visible.
  const left = anchor
    ? clamp(anchor.left, 8, window.innerWidth - MENU_WIDTH - 8)
    : 16
  const top = anchor
    ? Math.max(8, anchor.top - viewportHeight - 6)
    : undefined
  const bottom = anchor === null ? "calc(100% + 4px)" : undefined

  const rows: React.ReactNode[] = []
  for (let i = first; i < last; i++) {
    const option = options[i]!
    const isSelected = i === selectedIndex
    const dirIdx = option.path.lastIndexOf("/")
    const dir = dirIdx > 0 ? option.path.slice(0, dirIdx) : ""
    rows.push(
      <div
        key={option.path}
        role="option"
        aria-selected={isSelected}
        style={{
          position: "absolute",
          top: i * ROW_HEIGHT,
          left: 0,
          right: 0,
          height: ROW_HEIGHT,
        }}
        className={cn(
          "flex items-center gap-2 rounded-[2px] px-2 text-xs",
          isSelected
            ? "bg-accent text-accent-foreground"
            : "text-muted-foreground hover:bg-accent/50",
        )}
        onMouseEnter={() => onHover(i)}
        onMouseDown={e => {
          e.preventDefault()
          onSelect(option)
        }}
      >
        <FileIcon path={option.path} size={14} className="shrink-0" />
        <span className="truncate font-medium text-foreground">
          {option.name}
        </span>
        {dir ? (
          <span className="ml-auto truncate text-[11px] opacity-70">
            {dir}
          </span>
        ) : null}
      </div>,
    )
  }

  return (
    <div
      style={{
        position: anchor ? "fixed" : "absolute",
        left,
        top,
        bottom,
        width: MENU_WIDTH,
      }}
      className="z-50 overflow-hidden rounded-sm border border-border bg-popover text-popover-foreground shadow-xl"
    >
      <div
        ref={scrollerRef}
        className="relative overflow-y-auto p-0.5"
        style={{ height: viewportHeight }}
      >
        <div style={{ height: totalHeight, position: "relative" }}>{rows}</div>
      </div>
    </div>
  )
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}
