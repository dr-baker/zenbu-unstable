import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react"
import { Button } from "@zenbu/ui/button"
import { Input } from "@zenbu/ui/input"

type MatchInfo = {
  range: Range
  index: number
}

export type FindInChatProps = {
  scrollRef: RefObject<HTMLDivElement | null>
  contentVersion?: unknown
}

export function FindInChat({ scrollRef, contentVersion }: FindInChatProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [matches, setMatches] = useState<MatchInfo[]>([])
  const [currentIndex, setCurrentIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const matchesRef = useRef(matches)
  matchesRef.current = matches

  const close = useCallback(() => {
    setOpen(false)
    setQuery("")
    setMatches([])
    setCurrentIndex(0)
    CSS.highlights?.delete("find-matches")
    CSS.highlights?.delete("find-current")
  }, [])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "f") {
        e.preventDefault()
        setOpen(true)
        requestAnimationFrame(() => inputRef.current?.focus())
      }
      if (e.key === "Escape" && open) {
        e.preventDefault()
        close()
      }
    }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [open, close])

  const search = useCallback(
    (q: string) => {
      CSS.highlights?.delete("find-matches")
      CSS.highlights?.delete("find-current")
      if (!q || !scrollRef.current) {
        setMatches([])
        setCurrentIndex(0)
        return
      }
      const container = scrollRef.current
      const lower = q.toLowerCase()
      const found: MatchInfo[] = []
      const walker = document.createTreeWalker(
        container,
        NodeFilter.SHOW_TEXT,
        null,
      )
      let node: Text | null
      while ((node = walker.nextNode() as Text | null)) {
        const text = node.textContent?.toLowerCase() ?? ""
        let start = 0
        while (true) {
          const idx = text.indexOf(lower, start)
          if (idx === -1) break
          const range = document.createRange()
          range.setStart(node, idx)
          range.setEnd(node, idx + q.length)
          found.push({ range, index: found.length })
          start = idx + 1
        }
      }
      setMatches(found)
      setCurrentIndex(found.length > 0 ? 0 : -1)
      if (found.length > 0 && CSS.highlights) {
        const allRanges = found.map(m => m.range)
        CSS.highlights.set("find-matches", new Highlight(...allRanges))
        CSS.highlights.set("find-current", new Highlight(found[0].range))
      }
    },
    [scrollRef],
  )

  useEffect(() => {
    if (!open) return
    search(query)
  }, [query, open, search, contentVersion])

  const scrollToMatch = useCallback(
    (idx: number) => {
      const match = matchesRef.current[idx]
      if (!match || !scrollRef.current) return
      const rect = match.range.getBoundingClientRect()
      const containerRect = scrollRef.current.getBoundingClientRect()
      const relativeTop =
        rect.top - containerRect.top + scrollRef.current.scrollTop
      scrollRef.current.scrollTo({
        top: relativeTop - containerRect.height / 3,
        behavior: "instant",
      })
    },
    [scrollRef],
  )

  const goTo = useCallback(
    (idx: number) => {
      if (matches.length === 0) return
      const wrapped = ((idx % matches.length) + matches.length) % matches.length
      setCurrentIndex(wrapped)
      if (CSS.highlights) {
        CSS.highlights.set(
          "find-current",
          new Highlight(matches[wrapped].range),
        )
      }
      scrollToMatch(wrapped)
    },
    [matches, scrollToMatch],
  )

  const next = useCallback(() => goTo(currentIndex + 1), [goTo, currentIndex])
  const prev = useCallback(() => goTo(currentIndex - 1), [goTo, currentIndex])

  useEffect(() => {
    if (matches.length > 0 && currentIndex === 0) scrollToMatch(0)
  }, [matches, currentIndex, scrollToMatch])

  if (!open) return null

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault()
      if (e.shiftKey) prev()
      else next()
    }
  }

  return (
    <div className="absolute right-6 top-2 z-50 w-[340px]">
      <div className="flex items-center gap-1.5 rounded border border-border bg-popover px-3 py-1.5 text-popover-foreground shadow-xl">
        <Input
          ref={inputRef}
          type="text"
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Find in chat…"
          className="h-7 min-w-0 flex-1 border-0 bg-transparent px-0 py-0 text-sm shadow-none focus-visible:ring-0"
          autoFocus
        />
        <span className="w-16 whitespace-nowrap text-right text-xs tabular-nums text-muted-foreground">
          {query
            ? matches.length > 0
              ? `${currentIndex + 1} of ${matches.length}`
              : "0 results"
            : ""}
        </span>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={prev}
          disabled={matches.length === 0}
          className="text-muted-foreground hover:text-foreground"
        >
          <Chevron up />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={next}
          disabled={matches.length === 0}
          className="text-muted-foreground hover:text-foreground"
        >
          <Chevron />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={close}
          className="text-muted-foreground hover:text-foreground"
        >
          <X />
        </Button>
      </div>
    </div>
  )
}

function Chevron({ up = false }: { up?: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path
        d={up ? "M4 10L8 6L12 10" : "M4 6L8 10L12 6"}
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function X() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path
        d="M4 4L12 12M12 4L4 12"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  )
}
