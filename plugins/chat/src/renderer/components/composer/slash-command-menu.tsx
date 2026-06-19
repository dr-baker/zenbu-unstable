import { Fragment, useLayoutEffect, useRef } from "react"
import { Button } from "@zenbu/ui/button"
import { cn } from "@/lib/utils"
import { ensureRowInView } from "@/lib/ensure-row-in-view"
import { useHoverIntent } from "@/lib/hooks/use-hover-intent"
import type { SlashCommand } from "./types"

export type SlashCommandMenuProps = {
  options: SlashCommand[]
  selectedIndex: number
  onSelect: (option: SlashCommand) => void
  onHover: (index: number) => void
}

export function SlashCommandMenu({
  options,
  selectedIndex,
  onSelect,
  onHover,
}: SlashCommandMenuProps) {
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([])
  const hover = useHoverIntent()

  // Manual scroll math (see `ensureRowInView`) so the highlight
  // tracks the selection in the same paint instead of lagging a
  // keystroke behind when a row is rendered right at the viewport
  // edge.
  useLayoutEffect(() => {
    const scroller = scrollerRef.current
    const el = itemRefs.current[selectedIndex]
    if (scroller && el) ensureRowInView(scroller, el)
  }, [selectedIndex])

  if (options.length === 0) return null

  return (
    <div
      style={{ position: "absolute", bottom: "calc(100% + 4px)", left: 16 }}
      className="z-50 min-w-[220px] max-w-[340px] overflow-hidden rounded-sm border border-border bg-popover text-popover-foreground shadow-xl"
    >
      <div ref={scrollerRef} className="max-h-[280px] overflow-y-auto p-0.5">
        {options.map((option, i) => {
          const previous = i > 0 ? options[i - 1] : undefined
          const showGroup = option.group && option.group !== previous?.group
          return (
            <Fragment key={option.id}>
              {showGroup && (
                <div className="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
                  {option.group}
                </div>
              )}
              <Button
                ref={el => {
                  itemRefs.current[i] = el
                }}
                type="button"
                variant="ghost"
                role="option"
                aria-selected={selectedIndex === i}
                className={cn(
                  // `transition-none` overrides the ui/Button base's
                  // `transition-all`. With the default transition the
                  // bg/text crossfade between rows when the user arrows
                  // down quickly, so the highlight feels laggy. Snap
                  // instead.
                  "h-auto w-full items-start justify-start rounded-[2px] px-2 py-1.5 text-left text-xs font-normal transition-none",
                  selectedIndex === i
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground",
                )}
                onMouseMove={() => {
                  // Only react to hover once the user has actually moved
                  // the pointer since the menu opened. Prevents the menu
                  // from opening with selection on whichever row the
                  // cursor happened to be parked on.
                  if (hover.isActive()) onHover(i)
                }}
                onMouseDown={e => {
                  e.preventDefault()
                  onSelect(option)
                }}
              >
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate font-normal">{option.label}</span>
                    {option.hint && (
                      <span className="ml-auto shrink-0 text-[10px] opacity-60">
                        {option.hint}
                      </span>
                    )}
                  </span>
                  {option.description && (
                    <span className="truncate text-[11px] opacity-70">
                      {option.description}
                    </span>
                  )}
                </span>
              </Button>
            </Fragment>
          )
        })}
      </div>
    </div>
  )
}
