import { Fragment, useLayoutEffect, useRef, type ComponentType } from "react"

type SlashCommand = {
  id: string
  label: string
  description?: string
  group?: string
  hint?: string
}

type SlashCommandMenuProps = {
  options: SlashCommand[]
  selectedIndex: number
  onSelect: (option: SlashCommand) => void
  onHover: (index: number) => void
}

export function SkillPillsSlashCommandMenuAdvice<P extends SlashCommandMenuProps>(
  Original: ComponentType<P>,
  props: P,
) {
  if (!props.options.some(option => pillKindForOption(option) != null)) return <Original {...props} />
  return <SkillPillSlashCommandMenu {...props} />
}

function SkillPillSlashCommandMenu({
  options,
  selectedIndex,
  onSelect,
  onHover,
}: SlashCommandMenuProps) {
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([])
  const pointerMovedRef = useRef(false)

  useLayoutEffect(() => {
    const scroller = scrollerRef.current
    const el = itemRefs.current[selectedIndex]
    if (!scroller || !el) return

    const scrollerTop = scroller.scrollTop
    const scrollerBottom = scrollerTop + scroller.clientHeight
    const elTop = el.offsetTop
    const elBottom = elTop + el.offsetHeight

    if (elTop < scrollerTop) scroller.scrollTop = elTop
    else if (elBottom > scrollerBottom) {
      scroller.scrollTop = elBottom - scroller.clientHeight
    }
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
          const selected = selectedIndex === i
          const pillKind = pillKindForOption(option)
          return (
            <Fragment key={option.id}>
              {showGroup && (
                <div className="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
                  {option.group}
                </div>
              )}
              <button
                ref={el => {
                  itemRefs.current[i] = el
                }}
                type="button"
                role="option"
                aria-selected={selected}
                className={[
                  "flex h-auto w-full items-start justify-start rounded-[2px] px-2 py-1.5 text-left text-xs font-normal transition-none",
                  selected ? "bg-accent text-accent-foreground" : "text-muted-foreground",
                ].join(" ")}
                onMouseMove={() => {
                  if (!pointerMovedRef.current) pointerMovedRef.current = true
                  else onHover(i)
                }}
                onMouseDown={e => {
                  e.preventDefault()
                  onSelect(option)
                }}
              >
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="flex min-w-0 items-center gap-2">
                    {pillKind ? (
                      <span
                        className={[
                          "inline-flex min-w-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-semibold leading-none",
                          selected
                            ? "border-accent-foreground/25 bg-accent-foreground/10 text-accent-foreground"
                            : "border-border bg-accent text-accent-foreground",
                        ].join(" ")}
                      >
                        <span className="opacity-75">{pillKind === "prompt" ? "📖" : "✦"}</span>
                        <span className="truncate">{option.label}</span>
                      </span>
                    ) : (
                      <span className="truncate font-normal">{option.label}</span>
                    )}
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
              </button>
            </Fragment>
          )
        })}
      </div>
    </div>
  )
}

type PillKind = "skill" | "prompt"

function pillKindForOption(option: SlashCommand): PillKind | null {
  if (
    option.group === "Pi Skills" ||
    option.hint === "skill" ||
    option.hint?.startsWith("skill ·") === true
  ) {
    return "skill"
  }
  if (
    option.group === "Pi Prompts" ||
    option.hint === "prompt" ||
    option.hint?.startsWith("prompt ·") === true
  ) {
    return "prompt"
  }
  return null
}
