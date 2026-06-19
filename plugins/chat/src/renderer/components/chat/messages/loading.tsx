import { useEffect, useRef, useState } from "react"
import type { LoadingProps } from "../message-components"

/**
 * "Streaming…" footer shown beneath the message list while an agent
 * run is in flight. Renders the wall-clock elapsed since the user's
 * prompt was sent, plus the tokens this run has added to the
 * conversation context (i.e. delta of `stats.contextUsage.tokens`
 * since `agent_start`). Matches the rate at which the context view
 * and status bar advance.
 *
 * This component is pure presentation — no message walking, no
 * heuristics. The previous version counted words in materialized
 * messages as a stand-in for tokens; that's gone now that pi's real
 * context-usage measurement is plumbed through.
 */
export function Loading({ startTimestamp, tokens }: LoadingProps) {
  const time = useElapsed(startTimestamp)
  return (
    <div className="flex items-center gap-2 px-3 py-2">
      <span className="text-shimmer text-sm font-medium">
        {time},&nbsp; {tokens.toLocaleString()} Tokens
      </span>
    </div>
  )
}

function useElapsed(startTimestamp: number | null) {
  const [elapsed, setElapsed] = useState(() =>
    startTimestamp ? Math.floor((Date.now() - startTimestamp) / 1000) : 0,
  )
  const tsRef = useRef(startTimestamp)
  tsRef.current = startTimestamp

  useEffect(() => {
    if (tsRef.current == null) return
    const tick = () =>
      setElapsed(Math.floor((Date.now() - tsRef.current!) / 1000))
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [startTimestamp])

  const mins = Math.floor(elapsed / 60)
  const secs = elapsed % 60
  return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`
}
