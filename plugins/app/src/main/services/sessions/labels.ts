import type { DbService } from "@zenbujs/core/services"
import type { Session } from "./types"

type RootSnapshot = ReturnType<DbService["client"]["readRoot"]>

/**
 * Find a chat record pointing at this session. Returns the first
 * match — sessions are normally referenced by exactly one chat,
 * but in the (currently unreachable) case of multiple, picking the
 * first is good enough for the toast's "focus the chat" action.
 */
export function findChatIdForSession(args: {
  root: RootSnapshot
  sessionId: string
}): string | null {
  for (const chat of Object.values(args.root.app.chats)) {
    if (
      chat.session.kind === "ready" &&
      chat.session.sessionId === args.sessionId
    ) {
      return chat.id
    }
  }
  return null
}

/**
 * Main-side mirror of the renderer chat label: Pi's session name
 * is cached in `session.title`; unnamed sessions render as "New Chat".
 */
export function resolveSessionLabel(args: {
  root: RootSnapshot
  session: Session | undefined
}): string {
  const { session } = args
  if (!session) return "New Chat"
  const title = session.title?.trim()
  if (title && title !== "Untitled") return title
  return "New Chat"
}

export function truncateInline(args: { s: string; max: number }): string {
  const flat = args.s.replace(/\s+/g, " ").trim()
  if (flat.length <= args.max) return flat
  return flat.slice(0, args.max - 1) + "\u2026"
}

/**
 * Branch and compaction summaries carry an LLM-generated `summary`
 * string that's the actual content the user cares about. The sidebar
 * just renders this label, so we collapse whitespace and truncate
 * to one line. Fallback is used when the summary is missing or
 * empty (older entries without summaries).
 */
export function summaryExcerpt(args: {
  raw: unknown
  fallback?: string
}): string {
  const fallback = args.fallback ?? "branched"
  if (typeof args.raw !== "string") return fallback
  const trimmed = args.raw.replace(/\s+/g, " ").trim()
  if (!trimmed) return fallback
  return truncate({ s: trimmed, n: 80 })
}

export function deriveEntryLabel(args: { entry: any }): string {
  const { entry } = args
  switch (entry.type) {
    case "message": {
      const msg = entry.message
      if (!msg) return "message"
      switch (msg.role) {
        case "user":
          return excerptFromContent({ content: msg.content, role: "user" })
        case "assistant":
          return excerptFromContent({ content: msg.content, role: "assistant" })
        case "toolResult":
          return `↳ ${msg.toolName ?? "tool"}`
        case "bashExecution":
          return `$ ${truncate({ s: String(msg.command ?? ""), n: 60 })}`
        case "custom":
          return `custom: ${msg.customType ?? ""}`
        case "branchSummary":
          return summaryExcerpt({ raw: msg.summary })
        case "compactionSummary":
          return summaryExcerpt({ raw: msg.summary, fallback: "compacted" })
        default:
          return msg.role ?? "message"
      }
    }
    case "branch_summary":
      return summaryExcerpt({ raw: entry.summary })
    case "compaction":
      return summaryExcerpt({
        raw: entry.summary,
        fallback: `compacted (${entry.tokensBefore ?? 0} tok)`,
      })
    case "model_change":
      return `model → ${entry.provider}/${entry.modelId}`
    case "thinking_level_change":
      return `thinking → ${entry.thinkingLevel}`
    case "session_info":
      return entry.name ? `renamed: ${entry.name}` : "session info"
    case "custom":
      return `custom: ${entry.customType ?? ""}`
    case "custom_message":
      return `custom msg: ${entry.customType ?? ""}`
    case "label":
      return entry.label ? `label: ${entry.label}` : "label"
    default:
      return entry.type ?? "entry"
  }
}

export function excerptFromContent(args: {
  content: unknown
  role: "user" | "assistant"
}): string {
  const text = extractText({ content: args.content })
  const trimmed = text.trim()
  if (!trimmed) return args.role
  return truncate({ s: trimmed.replace(/\s+/g, " "), n: 60 })
}

export function extractTextContent(args: { content: unknown }): string {
  return extractText({ content: args.content })
}

export function extractText(args: { content: unknown }): string {
  const { content } = args
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  const parts: string[] = []
  for (const block of content as Array<{ type?: string; text?: string }>) {
    if (block && block.type === "text" && typeof block.text === "string") {
      parts.push(block.text)
    }
  }
  return parts.join(" ")
}

export function truncate(args: { s: string; n: number }): string {
  if (args.s.length <= args.n) return args.s
  return args.s.slice(0, args.n - 1) + "…"
}

export function parseTimestamp(args: {
  ts: string | number | undefined
}): number {
  const { ts } = args
  if (typeof ts === "number") return ts
  if (!ts) return 0
  const parsed = Date.parse(ts)
  return Number.isFinite(parsed) ? parsed : 0
}
