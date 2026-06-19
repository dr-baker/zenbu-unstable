import type { SessionManager } from "@earendil-works/pi-coding-agent"

/**
 * Force pi's SessionManager to write its current `fileEntries`
 * (typically just the session header at this point) to disk.
 *
 * Pi's public API has no "flush" method; `_rewriteFile` is
 * documented private but is the only call that does what we need.
 * Keep the cast confined to this helper so the rest of the
 * service stays type-safe.
 *
 * If pi later ships a public flush method, swap the body and this
 * comment goes away. The contract from callers' POV is simply:
 * "after this call returns, the session file exists on disk with
 * the correct session id in its header".
 */
export function flushSessionManagerHeader(args: { sm: SessionManager }): void {
  try {
    ;(args.sm as unknown as { _rewriteFile(): void })._rewriteFile()
  } catch (err) {
    console.error("[sessions] flushSessionManagerHeader failed:", err)
  }
}

/**
 * Subscribe once to a collection, capture the initial state
 * snapshot, then unsubscribe. Used by the invariant diagnostic
 * probe in `peekEventLogTail` to get an authoritative view of what
 * actually lives in main's replica — distinct from the in-memory
 * `live.seq` counter (which only tracks attempted appends).
 *
 * Times out after 500ms (the probe runs in the renderer's hot path
 * when an invariant fires; we'd rather report a probe failure than
 * block the report).
 */
export async function probeCollection(args: {
  node: {
    subscribeData(
      cb: (data: {
        collection: { id: string; totalCount: number; items: unknown[] }
        newItems: unknown[]
      }) => void,
    ): () => void
  }
  tail: number
}): Promise<{
  totalCount: number
  recentSeqs: Array<{ seq: number; kind: string; timestamp: number }>
  hasUserPromptWithText: string | null
  probeError: string | null
}> {
  const { node, tail } = args
  return new Promise(resolve => {
    let done = false
    let unsub: (() => void) | null = null
    const finish = (result: {
      totalCount: number
      recentSeqs: Array<{ seq: number; kind: string; timestamp: number }>
      hasUserPromptWithText: string | null
      probeError: string | null
    }) => {
      if (done) return
      done = true
      if (unsub) unsub()
      resolve(result)
    }
    const timeout = setTimeout(() => {
      finish({
        totalCount: -1,
        recentSeqs: [],
        hasUserPromptWithText: null,
        probeError: "probe timeout (500ms)",
      })
    }, 500)
    try {
      unsub = node.subscribeData(data => {
        clearTimeout(timeout)
        const items = data.collection.items as Array<{
          seq?: number
          kind?: string
          timestamp?: number
          payload?: { text?: string }
        }>
        const recent = items.slice(-tail).map(it => ({
          seq: typeof it.seq === "number" ? it.seq : -1,
          kind: typeof it.kind === "string" ? it.kind : "?",
          timestamp: typeof it.timestamp === "number" ? it.timestamp : 0,
        }))
        finish({
          totalCount: data.collection.totalCount,
          recentSeqs: recent,
          hasUserPromptWithText: null,
          probeError: null,
        })
      })
    } catch (err) {
      clearTimeout(timeout)
      finish({
        totalCount: -1,
        recentSeqs: [],
        hasUserPromptWithText: null,
        probeError: err instanceof Error ? err.message : String(err),
      })
    }
  })
}
