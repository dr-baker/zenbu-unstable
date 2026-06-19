import { useCallback, useMemo, useState } from "react"
import { ScrollSnapshot } from "./use-auto-scroll"

export type WindowedRange = {
  start: number | null
  end: number | null
}

type Options<T> = {
  items: T[]
  initialWindow?: number
  batchSize?: number
}

type Result<T> = {
  items: T[]
  hasMoreBefore: boolean
  hasMoreAfter: boolean
  loadOlder: (captureSnapshot: () => ScrollSnapshot | null) => void
  loadNewer: () => void
  freezeTail: () => void
  resumeTail: () => void
  totalCount: number
}

const LIVE_WINDOW: WindowedRange = { start: null, end: null }

function getWindowedRange(
  total: number,
  initialWindow: number,
  window: WindowedRange,
) {
  const end =
    window.end === null ? total : Math.max(0, Math.min(window.end, total))
  const start =
    window.start === null
      ? Math.max(0, end - initialWindow)
      : Math.max(0, Math.min(window.start, end))
  return { start, end }
}

export function useWindowedItems<T>({
  items,
  initialWindow = 200,
  batchSize = 100,
}: Options<T>): Result<T> {
  const [window, setWindow] = useState<WindowedRange>(LIVE_WINDOW)

  const range = useMemo(
    () => getWindowedRange(items.length, initialWindow, window),
    [items.length, initialWindow, window],
  )

  const visibleItems = useMemo(
    () => items.slice(range.start, range.end),
    [items, range.start, range.end],
  )

  const hasMoreBefore = range.start > 0
  const hasMoreAfter = range.end < items.length

  const freezeTail = useCallback(() => {
    setWindow(prev => getWindowedRange(items.length, initialWindow, prev))
  }, [items.length, initialWindow])

  const resumeTail = useCallback(() => {
    setWindow(prev => {
      if (prev.start === null && prev.end === null) return prev
      return LIVE_WINDOW
    })
  }, [])

  const loadOlder = useCallback(
    (captureSnapshot: () => ScrollSnapshot | null) => {
      if (!hasMoreBefore) return
      captureSnapshot()
      setWindow(prev => {
        const cur = getWindowedRange(items.length, initialWindow, prev)
        return {
          start: Math.max(0, cur.start - batchSize),
          end: cur.end,
        }
      })
    },
    [hasMoreBefore, items.length, initialWindow, batchSize],
  )

  const loadNewer = useCallback(() => {
    if (!hasMoreAfter) return
    setWindow(prev => {
      const cur = getWindowedRange(items.length, initialWindow, prev)
      return {
        start: cur.start,
        end: Math.min(items.length, cur.end + batchSize),
      }
    })
  }, [hasMoreAfter, items.length, initialWindow, batchSize])

  return {
    items: visibleItems,
    hasMoreBefore,
    hasMoreAfter,
    loadOlder,
    loadNewer,
    freezeTail,
    resumeTail,
    totalCount: items.length,
  }
}
