import path from "node:path"
import { Service, getPlugin } from "@zenbujs/core/runtime"
import { DbService, RpcService } from "@zenbujs/core/services"
import {
  getAgentDir,
  SettingsManager,
} from "@earendil-works/pi-coding-agent"

type WarningSettings = { anthropicExtraUsage?: boolean }

type SlashRegistry = {
  register(spec: RegisteredSlashCommand): Promise<{ ok: true }>
  unregister(args: { id: string }): Promise<{ ok: true }>
}

type RegisteredSlashCommand = {
  id: string
  name: string
  label: string
  description?: string | null
  hint?: string | null
  group?: string | null
  source?: string | null
  rpc: { plugin: string; service: string; method: string }
  args?: Record<string, unknown> | null
  insertOnSelect?: boolean
}

type SessionsApi = {
  setModel(args: {
    sessionId: string
    provider: string
    id: string
  }): Promise<void>
  clone(args: { sessionId: string; title?: string }): Promise<{
    sessionId: string
    chatId: string
    scopeId: string
  }>
  compact(args: { sessionId: string; instructions?: string }): Promise<unknown>
  reload(args: { sessionId: string }): Promise<{ ok: true }>
  exportSession(args: {
    sessionId: string
    outputPath?: string
  }): Promise<{ path: string; format: "html" | "jsonl" }>
  shareSession(args: { sessionId: string }): Promise<{
    gistUrl: string
    viewerUrl: string
  }>
  getLastAssistantText(args: { sessionId: string }): Promise<{ text: string | null }>
  setSessionName(args: { sessionId: string; name: string }): Promise<{ ok: true }>
  getSessionInfo(args: { sessionId: string }): Promise<unknown>
}

type Invocation = {
  windowId: string
  chatId?: string | null
  sessionId?: string | null
  command: string
  text?: string
  argsText?: string
}

/**
 * Result the slash-command dispatcher (chat-pane) needs to interpret.
 * Kept narrow on purpose: anything pi-commands-specific (the info /
 * tree / fork panels) is now written straight to our own db section
 * (`root.piCommands.panels[composerId]`) and consumed by our composer
 * advice. Chat-pane has no idea about those kinds.
 */
type CommandResult =
  | { kind: "none" }
  | { kind: "toast"; title: string; description?: string; tone?: "success" | "error" | "info" }
  | { kind: "clientAction"; action: "clone" | "closeCurrentChat" }
  | { kind: "openSettings"; tab?: "plugins"; sectionId?: string }

const PI_COMMANDS: ReadonlyArray<{
  name: string
  description: string
  insertOnSelect?: boolean
}> = [
  { name: "settings", description: "Open Pi settings" },
  { name: "model", description: "Select or set model", insertOnSelect: true },
  // TEMP: hidden while shipping to early users — no GUI panel yet.
  // { name: "scoped-models", description: "Enable/disable models for cycling" },
  { name: "export", description: "Export session to HTML or JSONL", insertOnSelect: true },
  // TEMP: hidden — no GUI panel yet.
  // { name: "import", description: "Import and resume a JSONL session", insertOnSelect: true },
  { name: "share", description: "Share session as a private GitHub gist" },
  { name: "copy", description: "Copy last assistant message" },
  { name: "name", description: "Set session display name", insertOnSelect: true },
  { name: "session", description: "Show session info and stats" },
  // TEMP: hidden — no GUI panel yet.
  // { name: "changelog", description: "Show Pi changelog" },
  // { name: "hotkeys", description: "Show keyboard shortcuts" },
  { name: "fork", description: "Fork from a previous user message" },
  { name: "clone", description: "Duplicate the current session" },
  { name: "tree", description: "Navigate session tree" },
  // TEMP: hidden — no GUI panel yet.
  // { name: "login", description: "Configure provider authentication" },
  // { name: "logout", description: "Remove provider authentication" },
  { name: "new", description: "Start a new session" },
  { name: "compact", description: "Manually compact context", insertOnSelect: true },
  // TEMP: hidden — no GUI panel yet.
  // { name: "resume", description: "Resume a different session" },
  { name: "reload", description: "Reload extensions, skills, prompts, themes" },
  { name: "quit", description: "Close the current chat tab" },
]

const BOOLEAN_VALUES = ["true", "false"] as const
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const
const TRANSPORTS = ["sse", "websocket", "websocket-cached", "auto"] as const
const DELIVERY_MODES = ["one-at-a-time", "all"] as const
const DOUBLE_ESCAPE_ACTIONS = ["tree", "fork", "none"] as const
const TREE_FILTER_MODES = ["default", "no-tools", "user-only", "labeled-only", "all"] as const

export type PiSettingItem = {
  id: string
  label: string
  description: string
  value: string
  values: string[]
}

export class PiCommandsService extends Service.create({
  key: "piCommands",
  deps: {
    db: DbService,
    rpc: RpcService,
    slashCommands: "slashCommands",
    sessions: "sessions",
  },
}) {
  evaluate() {
    this.setup("register-pi-slash-commands", () => {
      const registry = this.ctx.slashCommands as SlashRegistry
      for (const command of PI_COMMANDS) {
        void registry.register({
          id: `pi:${command.name}`,
          name: command.name,
          label: command.name,
          description: command.description,
          group: "Pi",
          source: "pi",
          rpc: { plugin: "piCommands", service: "piCommands", method: "run" },
          args: null,
          insertOnSelect: command.insertOnSelect ?? false,
        })
      }
      return () => {
        for (const command of PI_COMMANDS) {
          void registry.unregister({ id: `pi:${command.name}` })
        }
      }
    })

    this.setup("advise-composer-input", () => {
      const chatDir = getPlugin("chat")?.dir
      const composerModuleId = chatDir
        ? path.join(chatDir, "src/renderer/components/composer/composer.tsx")
        : "components/composer/composer.tsx"
      return this.advise({
        moduleId: composerModuleId,
        name: "Composer",
        type: "around",
        modulePath: "src/content/composer-input-advice.tsx",
        exportName: "ComposerInputAdvice",
      })
    })
  }

  async run(args: Invocation): Promise<CommandResult> {
    const command = args.command.replace(/^\//, "")
    const sessions = this.ctx.sessions as SessionsApi
    const sessionId = args.sessionId ?? undefined
    const argsText = args.argsText?.trim() ?? ""

    // `/settings` now drops the user on the new Plugins tab,
    // pre-selected to this plugin's section.
    if (command === "settings")
      return { kind: "openSettings", tab: "plugins", sectionId: "pi" }
    if (command === "clone") return { kind: "clientAction", action: "clone" }
    if (command === "quit") return { kind: "clientAction", action: "closeCurrentChat" }
    if (command === "new") {
      this.ctx.rpc.emit.app.newChatReplaceActive({ source: "pi-command/new" })
      return { kind: "none" }
    }
    if (!sessionId) {
      return {
        kind: "toast",
        tone: "error",
        title: `/${command} needs an active session`,
      }
    }

    if (command === "tree") {
      await this.setPanel(args.chatId, {
        kind: "tree",
        sessionId,
        windowId: args.windowId,
      })
      return { kind: "none" }
    }
    if (command === "fork") {
      await this.setPanel(args.chatId, {
        kind: "fork",
        sessionId,
        windowId: args.windowId,
      })
      return { kind: "none" }
    }

    switch (command) {
      case "model": {
        const parsed = parseProviderModel(argsText)
        if (!parsed) {
          return {
            kind: "toast",
            tone: "info",
            title: "Type /model provider/model-id",
            description: "The toolbar model picker is also available above the composer.",
          }
        }
        await sessions.setModel({ sessionId, provider: parsed.provider, id: parsed.id })
        return { kind: "toast", tone: "success", title: `Model set to ${argsText}` }
      }
      case "export": {
        const outputPath = parsePathArgument(argsText)
        const result = await sessions.exportSession({ sessionId, outputPath })
        await this.setPanel(args.chatId, {
          kind: "info",
          title: `Exported ${result.format.toUpperCase()}`,
          lines: [`Path: ${result.path}`],
        })
        return { kind: "none" }
      }
      case "share": {
        const result = await sessions.shareSession({ sessionId })
        await this.setPanel(args.chatId, {
          kind: "info",
          title: "Session shared",
          lines: [`Share URL: ${result.viewerUrl}`, `Gist: ${result.gistUrl}`],
        })
        return { kind: "none" }
      }
      case "copy": {
        const { text } = await sessions.getLastAssistantText({ sessionId })
        if (!text) {
          return { kind: "toast", tone: "error", title: "No assistant message to copy" }
        }
        await navigatorClipboardWriteText(text)
        return { kind: "toast", tone: "success", title: "Copied last assistant message" }
      }
      case "name": {
        if (!argsText) {
          return { kind: "toast", tone: "info", title: "Usage: /name <name>" }
        }
        await sessions.setSessionName({ sessionId, name: argsText })
        return { kind: "toast", tone: "success", title: `Session name set: ${argsText}` }
      }
      case "session": {
        const info = await sessions.getSessionInfo({ sessionId })
        const formatted = formatSessionInfo(info)
        if (formatted.kind === "info") {
          await this.setPanel(args.chatId, formatted)
          return { kind: "none" }
        }
        return formatted
      }
      case "compact": {
        await sessions.compact({ sessionId, instructions: argsText || undefined })
        return { kind: "toast", tone: "success", title: "Compaction started" }
      }
      case "reload": {
        await sessions.reload({ sessionId })
        return { kind: "toast", tone: "success", title: "Reloaded Pi resources" }
      }
      case "scoped-models":
      case "import":
      case "resume":
      case "login":
      case "logout":
      case "hotkeys":
      case "changelog":
        return {
          kind: "toast",
          tone: "info",
          title: `/${command} is registered`,
          description: "This command needs a richer GUI panel; the extensible dispatch path is in place.",
        }
      default:
        return { kind: "none" }
    }
  }

  /**
   * Write a panel for a given composer (= chat). The composer-input
   * advice subscribes to this slot and renders the panel JSX.
   * No-op when `composerId` is missing — panels are addressed per
   * composer instance.
   */
  private async setPanel(
    composerId: string | null | undefined,
    panel: import("../schema").PiCommandPanel,
  ): Promise<void> {
    if (!composerId) return
    await this.ctx.db.client.update(root => {
      root.piCommands.panels[composerId] = panel
    })
  }

  /** Renderer-callable: close the panel for `composerId`. The
   *  composer-input advice invokes this on the panel's onCancel /
   *  onConfirm callbacks. */
  async closePanel(args: { composerId: string }): Promise<{ ok: true }> {
    await this.ctx.db.client.update(root => {
      delete root.piCommands.panels[args.composerId]
    })
    return { ok: true }
  }

  getPiSettings(args: { cwd?: string | null }): { items: PiSettingItem[] } {
    const manager = this.createSettingsManager(args.cwd)
    return { items: buildSettingsItems(manager) }
  }

  async setPiSetting(args: {
    cwd?: string | null
    id: string
    value: string
  }): Promise<{ items: PiSettingItem[] }> {
    const manager = this.createSettingsManager(args.cwd)
    applySetting(manager, args.id, args.value)
    await manager.flush()
    return { items: buildSettingsItems(manager) }
  }

  private createSettingsManager(cwd?: string | null): SettingsManager {
    return SettingsManager.create(cwd || process.cwd(), getAgentDir())
  }
}

function parseProviderModel(text: string): { provider: string; id: string } | null {
  const slash = text.indexOf("/")
  if (slash <= 0 || slash === text.length - 1) return null
  return { provider: text.slice(0, slash), id: text.slice(slash + 1) }
}

function parsePathArgument(text: string): string | undefined {
  const trimmed = text.trimStart()
  if (!trimmed) return undefined
  const first = trimmed[0]
  if (first === "\"" || first === "'") {
    const end = trimmed.indexOf(first, 1)
    return end < 0 ? undefined : trimmed.slice(1, end)
  }
  const ws = trimmed.search(/\s/)
  return ws < 0 ? trimmed : trimmed.slice(0, ws)
}

async function navigatorClipboardWriteText(text: string): Promise<void> {
  const { copyToClipboard } = await import("@earendil-works/pi-coding-agent")
  await copyToClipboard(text)
}

/** Locally-typed result of formatting session info — either an info
 *  panel (written to db by the caller) or a toast (passed through). */
type FormattedSessionInfo =
  | { kind: "info"; title: string; lines: string[] }
  | { kind: "toast"; tone: "success" | "error" | "info"; title: string; description?: string }

function formatSessionInfo(info: unknown): FormattedSessionInfo {
  if (!info || typeof info !== "object") {
    return { kind: "toast", tone: "error", title: "Unable to read session info" }
  }
  const data = info as {
    name?: string | null
    file?: string | null
    id?: string
    stats?: {
      userMessages?: number
      assistantMessages?: number
      toolCalls?: number
      toolResults?: number
      totalMessages?: number
      tokens?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number }
      cost?: number
    }
  }
  const stats = data.stats
  const lines = [
    data.name ? `Name: ${data.name}` : null,
    `File: ${data.file ?? "In-memory"}`,
    `ID: ${data.id ?? "unknown"}`,
    stats ? `Messages: ${stats.totalMessages ?? 0} total (${stats.userMessages ?? 0} user, ${stats.assistantMessages ?? 0} assistant)` : null,
    stats ? `Tools: ${stats.toolCalls ?? 0} calls, ${stats.toolResults ?? 0} results` : null,
    stats?.tokens ? `Tokens: ${stats.tokens.total?.toLocaleString() ?? 0} total` : null,
    stats?.cost ? `Cost: $${stats.cost.toFixed(4)}` : null,
  ].filter((line): line is string => line !== null)
  return { kind: "info", title: "Session info", lines }
}

function buildSettingsItems(manager: SettingsManager): PiSettingItem[] {
  const warnings = manager.getWarnings()
  return [
    item("autocompact", "Auto-compact", "Automatically compact context when it gets too large", String(manager.getCompactionEnabled()), [...BOOLEAN_VALUES]),
    item("show-images", "Show images", "Render images inline in terminals that support it", String(manager.getShowImages()), [...BOOLEAN_VALUES]),
    item("image-width-cells", "Image width", "Preferred inline image width in terminal cells", String(manager.getImageWidthCells()), ["60", "80", "120"]),
    item("auto-resize-images", "Auto-resize images", "Resize large images before sending to model providers", String(manager.getImageAutoResize()), [...BOOLEAN_VALUES]),
    item("block-images", "Block images", "Prevent images from being sent to LLM providers", String(manager.getBlockImages()), [...BOOLEAN_VALUES]),
    item("skill-commands", "Skill commands", "Register skills as /skill:name commands", String(manager.getEnableSkillCommands()), [...BOOLEAN_VALUES]),
    item("show-hardware-cursor", "Show hardware cursor", "Show terminal cursor while positioning it for IME support", String(manager.getShowHardwareCursor()), [...BOOLEAN_VALUES]),
    item("editor-padding", "Editor padding", "Horizontal padding for Pi's terminal input editor", String(manager.getEditorPaddingX()), ["0", "1", "2", "3"]),
    item("autocomplete-max-visible", "Autocomplete max items", "Max visible items in Pi autocomplete dropdown", String(manager.getAutocompleteMaxVisible()), ["3", "5", "7", "10", "15", "20"]),
    item("clear-on-shrink", "Clear on shrink", "Clear empty rows when terminal content shrinks", String(manager.getClearOnShrink()), [...BOOLEAN_VALUES]),
    item("terminal-progress", "Terminal progress", "Show OSC 9;4 progress indicators in terminal tab bar", String(manager.getShowTerminalProgress()), [...BOOLEAN_VALUES]),
    item("steering-mode", "Steering mode", "How steering messages are delivered while streaming", manager.getSteeringMode(), [...DELIVERY_MODES]),
    item("follow-up-mode", "Follow-up mode", "How follow-up messages are delivered after a turn", manager.getFollowUpMode(), [...DELIVERY_MODES]),
    item("transport", "Transport", "Preferred provider transport", manager.getTransport(), [...TRANSPORTS]),
    item("hide-thinking", "Hide thinking", "Hide thinking blocks in assistant responses", String(manager.getHideThinkingBlock()), [...BOOLEAN_VALUES]),
    item("collapse-changelog", "Collapse changelog", "Show condensed changelog after updates", String(manager.getCollapseChangelog()), [...BOOLEAN_VALUES]),
    item("quiet-startup", "Quiet startup", "Hide Pi startup header", String(manager.getQuietStartup()), [...BOOLEAN_VALUES]),
    item("install-telemetry", "Install telemetry", "Send anonymous install/update version ping", String(manager.getEnableInstallTelemetry()), [...BOOLEAN_VALUES]),
    item("double-escape-action", "Double-escape action", "Action for double Escape with an empty editor", manager.getDoubleEscapeAction(), [...DOUBLE_ESCAPE_ACTIONS]),
    item("tree-filter-mode", "Tree filter mode", "Default filter when opening /tree", manager.getTreeFilterMode(), [...TREE_FILTER_MODES]),
    item("warnings.anthropicExtraUsage", "Anthropic extra usage warning", "Warn when Anthropic subscription auth may use paid extra usage", String(warnings.anthropicExtraUsage ?? true), [...BOOLEAN_VALUES]),
    item("thinking", "Thinking level", "Default reasoning depth for thinking-capable models", manager.getDefaultThinkingLevel() ?? "high", [...THINKING_LEVELS]),
    item("theme", "Theme", "Pi terminal theme", manager.getTheme() ?? "dark", ["dark", "light"]),
  ]
}

function item(
  id: string,
  label: string,
  description: string,
  value: string,
  values: string[],
): PiSettingItem {
  return { id, label, description, value, values }
}

function applySetting(manager: SettingsManager, id: string, value: string): void {
  switch (id) {
    case "autocompact":
      manager.setCompactionEnabled(value === "true")
      break
    case "show-images":
      manager.setShowImages(value === "true")
      break
    case "image-width-cells":
      manager.setImageWidthCells(Number(value))
      break
    case "auto-resize-images":
      manager.setImageAutoResize(value === "true")
      break
    case "block-images":
      manager.setBlockImages(value === "true")
      break
    case "skill-commands":
      manager.setEnableSkillCommands(value === "true")
      break
    case "show-hardware-cursor":
      manager.setShowHardwareCursor(value === "true")
      break
    case "editor-padding":
      manager.setEditorPaddingX(Number(value))
      break
    case "autocomplete-max-visible":
      manager.setAutocompleteMaxVisible(Number(value))
      break
    case "clear-on-shrink":
      manager.setClearOnShrink(value === "true")
      break
    case "terminal-progress":
      manager.setShowTerminalProgress(value === "true")
      break
    case "steering-mode":
      if (isOneOf(value, DELIVERY_MODES)) manager.setSteeringMode(value)
      break
    case "follow-up-mode":
      if (isOneOf(value, DELIVERY_MODES)) manager.setFollowUpMode(value)
      break
    case "transport":
      if (isOneOf(value, TRANSPORTS)) manager.setTransport(value)
      break
    case "hide-thinking":
      manager.setHideThinkingBlock(value === "true")
      break
    case "collapse-changelog":
      manager.setCollapseChangelog(value === "true")
      break
    case "quiet-startup":
      manager.setQuietStartup(value === "true")
      break
    case "install-telemetry":
      manager.setEnableInstallTelemetry(value === "true")
      break
    case "double-escape-action":
      if (isOneOf(value, DOUBLE_ESCAPE_ACTIONS)) manager.setDoubleEscapeAction(value)
      break
    case "tree-filter-mode":
      if (isOneOf(value, TREE_FILTER_MODES)) manager.setTreeFilterMode(value)
      break
    case "warnings.anthropicExtraUsage": {
      const warnings: WarningSettings = {
        ...manager.getWarnings(),
        anthropicExtraUsage: value === "true",
      }
      manager.setWarnings(warnings)
      break
    }
    case "thinking":
      if (isOneOf(value, THINKING_LEVELS)) manager.setDefaultThinkingLevel(value)
      break
    case "theme":
      manager.setTheme(value)
      break
  }
}

function isOneOf<const T extends readonly string[]>(value: string, values: T): value is T[number] {
  return values.includes(value)
}
