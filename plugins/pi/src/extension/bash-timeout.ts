import type { ImageContent, TextContent } from "@earendil-works/pi-ai"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import {
  isBashToolResult,
  isToolCallEventType,
} from "@earendil-works/pi-coding-agent"

const DEFAULT_TIMEOUT_MS = 2 * 60 * 1000
const MS_PER_SECOND = 1000

const TIMEOUT_RETRY_HINT =
  "If this command is expected to take longer and is not waiting for interactive input, retry with a larger timeout value in seconds."

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (!value) return undefined

  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) return undefined

  return parsed
}

function defaultTimeoutSeconds(): number {
  const configuredMilliseconds =
    parsePositiveInteger(process.env.PI_BASH_DEFAULT_TIMEOUT_MS) ??
    parsePositiveInteger(process.env.OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS) ??
    DEFAULT_TIMEOUT_MS

  return Math.ceil(configuredMilliseconds / MS_PER_SECOND)
}

function bashPolicyPrompt(defaultTimeout: number): string {
  return [
    "# Bash timeout and tool-use policy",
    "",
    `Bash commands time out after ${defaultTimeout * MS_PER_SECOND}ms by default.`,
    "You can specify an optional timeout in seconds for commands expected to take longer.",
    "If a command times out, retry with a larger timeout value in seconds rather than removing path scope.",
    "",
    "IMPORTANT: The bash tool is for terminal operations like git, npm, docker, test runners, and build commands.",
    "Do not use bash for file operations like reading, writing, editing, searching, or finding files unless explicitly instructed or truly necessary.",
    "Use the specialized tools instead:",
    "- File search: use the find tool, not bash find or ls",
    "- Content search: use the grep tool, not bash grep or rg",
    "- Read files: use the read tool, not cat/head/tail",
    "- Edit files: use the edit tool, not sed/awk",
    "- Write files: use the write tool, not echo redirection or heredocs",
    "",
    "When you do use bash, quote paths containing spaces. Avoid wide commands like find / or repo-root grep/rg without a scoped path.",
  ].join("\n")
}

function appendTimeoutHint(
  content: readonly (TextContent | ImageContent)[],
): (TextContent | ImageContent)[] | undefined {
  let changed = false
  const next = content.map(item => {
    if (item.type !== "text") return item
    if (!item.text.includes("Command timed out after")) return item
    if (item.text.includes(TIMEOUT_RETRY_HINT)) return item

    changed = true
    return { ...item, text: `${item.text}\n\n${TIMEOUT_RETRY_HINT}` }
  })

  return changed ? next : undefined
}

export default function bashTimeout(pi: ExtensionAPI) {
  const defaultTimeout = defaultTimeoutSeconds()

  pi.on("before_agent_start", event => ({
    systemPrompt: `${event.systemPrompt}\n\n${bashPolicyPrompt(defaultTimeout)}`,
  }))

  pi.on("tool_call", event => {
    if (!isToolCallEventType("bash", event)) return undefined

    if (event.input.timeout !== undefined && event.input.timeout <= 0) {
      return {
        block: true,
        reason: `Invalid timeout value: ${event.input.timeout}. Timeout must be a positive number.`,
      }
    }

    event.input.timeout ??= defaultTimeout
    return undefined
  })

  pi.on("tool_result", event => {
    if (!isBashToolResult(event) || !event.isError) return undefined

    const content = appendTimeoutHint(event.content)
    return content ? { content } : undefined
  })
}
