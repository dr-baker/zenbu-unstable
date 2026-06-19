import type { AgentSession } from "@earendil-works/pi-coding-agent"
import type { Session } from "./types"

export function emptyStats(): Session["stats"] {
  return {
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    cost: 0,
    contextUsage: null,
    autoCompactionEnabled: true,
  }
}

/**
 * Compute the same rollup pi's footer renders: cumulative assistant usage across
 * ALL session entries (including pre-compaction history), plus the live context
 * window estimate from `getContextUsage()`.
 */
export function computeStats(args: { pi: AgentSession }): Session["stats"] {
  const { pi } = args
  let input = 0
  let output = 0
  let cacheRead = 0
  let cacheWrite = 0
  let cost = 0
  for (const entry of pi.sessionManager.getEntries()) {
    if (entry.type === "message" && entry.message.role === "assistant") {
      const usage = entry.message.usage
      input += usage.input
      output += usage.output
      cacheRead += usage.cacheRead
      cacheWrite += usage.cacheWrite
      cost += usage.cost.total
    }
  }
  const ctx = pi.getContextUsage()
  return {
    tokens: { input, output, cacheRead, cacheWrite },
    cost,
    contextUsage: ctx
      ? {
          tokens: ctx.tokens,
          contextWindow: ctx.contextWindow,
          percent: ctx.percent,
        }
      : null,
    autoCompactionEnabled: pi.autoCompactionEnabled,
  }
}

export function latestBranchSummary(args: {
  branch: Array<{ type?: string; summary?: string }>
}): string | null {
  for (const entry of args.branch) {
    if (entry?.type === "branch_summary" && typeof entry.summary === "string") {
      const trimmed = entry.summary.trim()
      if (trimmed.length > 0) return trimmed
    }
  }
  return null
}

export function countLeaves(args: {
  entries: Array<{ id: string; parentId: string | null }>
}): number {
  const { entries } = args
  if (entries.length === 0) return 1
  const hasChildren = new Set<string>()
  for (const e of entries) {
    if (e.parentId) hasChildren.add(e.parentId)
  }
  let leaves = 0
  for (const e of entries) {
    if (!hasChildren.has(e.id)) leaves++
  }
  return Math.max(1, leaves)
}
