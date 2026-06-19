import { useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import { useCollection, useDb, useDbClient, useRpc } from "@zenbujs/core/react"
import { ChatDisplay } from "./chat-display"
import { ChatTitleBar } from "./chat-title-bar"
import { InvariantOverlay } from "./devtools/invariant-overlay"
import { useMessageDeliveryInvariant } from "./devtools/use-message-delivery-invariant"
import { materializeMessages } from "./lib/materialize"
import { QueuedMessages } from "./queued-messages"
import { WorkspaceSelector } from "./workspace-selector"
import { WorktreeHandoffSelector } from "./worktree-handoff-selector"
import { Composer, type ComposerSubmitPayload } from "../composer/composer"
import { useChatDraft } from "./lib/use-chat-draft"
import type { AgentConfig } from "../composer/composer-toolbar"
import type { ComboboxOption } from "../composer/combobox"
import type { FileEntry, SlashCommand } from "../composer/types"
import { cn } from "@/lib/utils"
import { ErrorBoundary } from "@/components/common/error-boundary"
import { PiFooter } from "../pi-footer/pi-footer"
import { FileIndexContext } from "./lib/file-index-context"
import { ChatAuthCard } from "@/components/auth/chat-auth-card"
import {
  useChatBackground,
  useChatBackgroundUrl,
} from "@/lib/chat-background"
import { useWindowId } from "@/lib/window-state/window-id"
import {
  closeTabInRoot,
  openChatInNewTabInRoot,
} from "@/lib/window-state/panes/tabs"
import { openSettingsInRoot } from "@/lib/window-state/panes/views"
import type { Schema } from "@host/main/schema"
import type { SelfDbSection as PiSchema } from "../../../../.zenbu/types/deps/pi/db-sections"

type Chat = Schema["chats"][string]
type Session = PiSchema["sessions"][string]
type RegisteredSlashCommand = Schema["slashCommands"][string]
type EventLogItem = {
  seq: number
  kind: string
  payload: unknown
  timestamp: number
}
type EventLogNode = {
  subscribeData(cb: (data: { newItems: EventLogItem[] }) => void): () => void
}
type DbClientWithEventLog = {
  pi: { sessions: Record<string, { eventLog: EventLogNode } | undefined> }
}

/**
 * Generic slash-command result kinds chat-pane interprets. Anything
 * plugin-specific (e.g. pi-commands' info/tree/fork panels) is
 * handled by the owning plugin itself — the plugin's slash RPC
 * writes its own state to its own db section and the plugin's
 * advice reads it. Chat-pane stays oblivious.
 */
type SlashCommandResult =
  | { kind: "none" }
  | {
      kind: "toast"
      title: string
      description?: string
      tone?: "success" | "error" | "info"
    }
  | {
      kind: "clientAction"
      action: "clone" | "closeCurrentChat"
    }
  | { kind: "openSettings"; tab?: "plugins"; sectionId?: string }

const PI_AGENT_ID = "pi"
const THINKING_LEVELS: ReadonlyArray<{
  value: Session["thinkingLevel"]
  name: string
}> = [
  { value: "off", name: "Off" },
  { value: "minimal", name: "Minimal" },
  { value: "low", name: "Low" },
  { value: "medium", name: "Medium" },
  { value: "high", name: "High" },
  { value: "xhigh", name: "Extra High" },
]

export type ChatPaneProps = {
  chat: Chat | null
  /** When false, the chat-pane rounds its left corners (no adjacent panel). */
  leftAdjacent?: boolean
  /** When true, another panel sits flush below (e.g. terminal). Kept on the
   * public API for callers, but the chat-pane no longer draws a bottom
   * border or bottom corner rounding either way — the outer app shell owns
   * the bottom edge. */
  bottomAdjacent?: boolean
  /** When true, another panel sits flush to the right (e.g. a sidebar
   * view). Strips the chat-pane's right corners so the two panes read
   * as one continuous frame. */
  rightAdjacent?: boolean
  /** When true, something sits flush above this pane (e.g. a tab bar).
   * Drops the top border + top corner rounding so the bar above owns
   * the top edge of the frame instead. */
  topAdjacent?: boolean
}

export function ChatPane({
  chat,
  leftAdjacent = false,
  bottomAdjacent = false,
  rightAdjacent = false,
  topAdjacent = false,
}: ChatPaneProps) {
  const windowId = useWindowId()
  const rpc = useRpc()
  const dbClient = useDbClient()
  const scrollToBottomRef = useRef<(() => void) | null>(null)
  const autoScrollTapCleanupRef = useRef<(() => void) | null>(null)
  // Tracks whether the chat's scroll content actually overflows.
  // Threaded into <ChatTitleBar /> so the fade gradient under the
  // bar only renders when there's content below it to fade into.
  const [chatHasOverflow, setChatHasOverflow] = useState(false)

  const sessionId =
    chat?.session.kind === "ready" ? chat.session.sessionId : null

  useEffect(() => {
    return () => {
      autoScrollTapCleanupRef.current?.()
      autoScrollTapCleanupRef.current = null
    }
  }, [sessionId])

  useEffect(() => {
    if (!sessionId) return
    const subscriberId = `window-${windowId}-${sessionId}`
    rpc.pi.sessions
      .subscribe({ sessionId, subscriberId })
      .catch(err => console.error("[chat] subscribe failed:", err))
    return () => {
      rpc.pi.sessions
        .unsubscribe({ sessionId, subscriberId })
        .catch(err => console.error("[chat] unsubscribe failed:", err))
    }
  }, [sessionId, windowId, rpc])

  const background = useChatBackground()
  const backgroundUrl = useChatBackgroundUrl(background)

  const session = useDb(root =>
    sessionId ? root.pi.sessions[sessionId] : undefined,
  )
  const eventLogRef = useDb(root =>
    sessionId ? root.pi.sessions[sessionId]?.eventLog : undefined,
  )
  const { items: events } = useCollection(eventLogRef)
  const models = useDb(root => root.pi.models)

  // Per-scope path index, maintained by FileTreeService. Paths live in
  // a collection so indexing doesn't bloat root.json; useCollection
  // streams them in as the service publishes chunks.
  const filePathsRef = useDb(root =>
    chat ? root.app.fileTreeIndexes[chat.scopeId]?.paths : undefined,
  )
  const { items: filePathItems } = useCollection(filePathsRef)
  const filePaths = useMemo(
    () => filePathItems.map(item => item.path),
    [filePathItems],
  )
  // Worktree directory the chat is anchored at. Threaded through
  // `materializeMessages` so the post-turn summary card knows which
  // `directory` to forward when it opens a `git-diff` split, and so
  // it can strip the absolute-path prefix off edit-tool args (most
  // tools record `file_path` as an absolute path).
  const chatDirectory = useDb(root =>
    chat ? root.app.scopes[chat.scopeId]?.directory ?? null : null,
  )
  // Extra worktree directories the scope has access to. Edits to
  // files inside any of these need to route through *that* dir
  // when opening a diff, not the scope's primary cwd — each extra
  // dir is its own git worktree and `pr.getStatus` is scoped per
  // directory, so the diff viewer would otherwise find nothing.
  // Threaded into `materializeMessages` so the turn-summary card
  // can stamp each file row with its owning directory.
  const chatExtraDirectories = useDb(root =>
    chat ? root.app.scopes[chat.scopeId]?.extraDirectories ?? [] : [],
  )
  // Workspace + scope the chat owns. Threaded through to the
  // turn-summary card so clicking a file opens the diff in *this*
  // chat's workspace/worktree instead of whatever the window's
  // active workspace happens to be at click time. Without this the
  // shell falls back to `activeWorkspaceIdOf(ws)` and the diff can
  // end up in a sibling workspace's pane state — silently teleporting
  // the user there.
  const chatScopeId = chat?.scopeId ?? null
  const chatWorkspaceId = useDb(root =>
    chat ? root.app.scopes[chat.scopeId]?.workspaceId ?? null : null,
  )
  const files = useMemo<FileEntry[]>(() => {
    if (!filePaths) return []
    const out: FileEntry[] = new Array(filePaths.length)
    for (let i = 0; i < filePaths.length; i++) {
      const p = filePaths[i]!
      const slash = p.lastIndexOf("/")
      out[i] = { path: p, name: slash >= 0 ? p.slice(slash + 1) : p }
    }
    return out
  }, [filePaths])

  const currentModelValue =
    session?.model ? `${session.model.provider}/${session.model.id}` : undefined
  const currentModel: PiSchema["models"][string] | undefined =
    currentModelValue ? models[currentModelValue] : undefined

  const modelOptions = useMemo<ComboboxOption[]>(() => {
    return Object.values(models).map(m => ({
      value: `${m.provider}/${m.id}`,
      name: m.name,
      description: m.provider,
    }))
  }, [models])

  const thinkingOptions = useMemo<ComboboxOption[]>(() => {
    if (!currentModel || !currentModel.reasoning) return []
    return THINKING_LEVELS.filter(l => {
      const map = currentModel.thinkingLevelMap
      if (!map) return true
      const mapped = map[l.value]
      return mapped !== null
    }).map(l => ({ value: l.value, name: l.name }))
  }, [currentModel])

  const agentConfigs = useMemo<AgentConfig[]>(
    () => [
      {
        id: PI_AGENT_ID,
        name: "pi",
        availableModels: modelOptions,
        availableThinkingLevels: thinkingOptions,
      },
    ],
    [modelOptions, thinkingOptions],
  )

  // Per-chat lock state. When `locked`, the composer refuses to submit
  // and shows a lock icon in place of the interrupt button. Stored in
  // the DB so it survives reloads and follows the chat as you switch.
  const locked = useDb(root =>
    chat ? root.app.chatStates[chat.id]?.locked ?? false : false,
  )

  // What the plain Enter key does while streaming: queue (followUp)
  // or steer. Configurable from Settings; also flippable in-line via
  // the `/set-default-...` slash command. Mod-Enter and the `/steer`
  // / `/queue` slash commands ignore this and force their own intent.
  const defaultSendMode = useDb(root => root.app.settings.defaultSendMode)
  const showChatDevtools = useDb(root => root.app.settings.chatDevtools)
  const registeredSlashCommands = useDb(root => root.app.slashCommands)

  // The slash menu lists:
  //   - `/queue` and `/steer`: send the current input with that
  //     intent right now. Picking the command IS the send — no
  //     sticky mode chip in the input.
  //   - exactly one of `/set-default-queue` or `/set-default-steer`:
  //     whichever flips the current default. Showing both would let
  //     the user pick the no-op.
  //   - exactly one of `/lock` or `/unlock`, same idea.
  const slashCommands = useMemo<SlashCommand[]>(() => {
    const registeredCmds: SlashCommand[] = Object.values(registeredSlashCommands)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(cmd => ({
        id: `registered:${cmd.id}`,
        label: cmd.label,
        description: cmd.description ?? undefined,
        group: cmd.group ?? undefined,
        hint: cmd.hint ?? cmd.source ?? undefined,
        action: cmd.insertOnSelect ? undefined : `registered:${cmd.id}`,
        insertText: cmd.insertOnSelect ? `/${cmd.name} ` : undefined,
        completionText: `/${cmd.name}`,
      }))
    const hasRegistered = (name: string) =>
      Object.values(registeredSlashCommands).some(cmd => cmd.name === name)

    const sendCmds: SlashCommand[] = [
      {
        id: "queue",
        label: "queue",
        description: "send now, queue after the current turn finishes",
        completionText: "/queue",
        submitWith: "followUp",
      },
      {
        id: "steer",
        label: "steer",
        description: "send now, interject before the agent's next LLM call",
        completionText: "/steer",
        submitWith: "steer",
      },
    ]
    const defaultCmd: SlashCommand =
      defaultSendMode === "followUp"
        ? {
            id: "set-default-steer",
            label: "set default to steer",
            description: "plain Enter while streaming will steer",
            action: "set-default-steer",
            completionText: "/set-default-steer",
          }
        : {
            id: "set-default-queue",
            label: "set default to queue",
            description: "plain Enter while streaming will queue",
            action: "set-default-queue",
            completionText: "/set-default-queue",
          }
    const lockCmd: SlashCommand = locked
      ? {
          id: "unlock",
          label: "unlock",
          description: "allow Enter to send again",
          action: "unlock",
          completionText: "/unlock",
        }
      : {
          id: "lock",
          label: "lock",
          description: "lock the input so Enter inserts a newline",
          action: "lock",
          completionText: "/lock",
        }
    const cloneCmd: SlashCommand = {
      id: "clone",
      label: "clone",
      description: "duplicate the session at the current position",
      action: "clone",
      completionText: "/clone",
    }
    const workspaceCmd: SlashCommand = {
      id: "workspace",
      label: "move-to-worktree",
      description: "move this chat into a new git worktree",
      action: "openWorkspace",
      completionText: "/move-to-worktree",
    }
    const handoffCmd: SlashCommand = {
      id: "worktree-handoff",
      label: "worktree-handoff",
      description:
        "rebase onto / land on another worktree (run twice: rebase, test, land)",
      action: "openHandoff",
      completionText: "/worktree-handoff",
    }
    return [
      ...sendCmds,
      ...registeredCmds,
      workspaceCmd,
      handoffCmd,
      ...(hasRegistered("clone") ? [] : [cloneCmd]),
      defaultCmd,
      lockCmd,
    ]
  }, [locked, defaultSendMode, registeredSlashCommands])

  // Panel state for slash commands that take over the composer
  // slot. `/tree` and `/fork` share the same component with
  // different confirmation flows; `/workspace` is its own panel
  // (branch-name input). All three render at the same DOM slot,
  // mutually exclusive, so we model them in one union here.
  const [treePanel, setTreePanel] = useState<
    | { kind: "closed" }
    | { kind: "workspace" }
    | { kind: "handoff" }
  >({ kind: "closed" })
  const treePanelOpen = treePanel.kind !== "closed"

  const handleRegisteredSlashResult = (result: unknown) => {
    if (!chat || !result || typeof result !== "object") return
    const r = result as SlashCommandResult
    if (r.kind === "toast") {
      const fn = r.tone === "error" ? toast.error : r.tone === "success" ? toast.success : toast
      fn(r.title, { description: r.description })
      return
    }
    if (r.kind === "openSettings") {
      dbClient.update(root => {
        const args: Record<string, unknown> = {}
        if (r.tab) args.tab = r.tab
        if (r.sectionId) args.sectionId = r.sectionId
        openSettingsInRoot(root, windowId, args)
      })
      return
    }
    if (r.kind === "clientAction") {
      if (r.action === "clone") {
        if (!sessionId) return
        void (async () => {
          try {
            const cloned = await rpc.pi.sessions.clone({ sessionId })
            dbClient.update(root => {
              openChatInNewTabInRoot(root, windowId, cloned.chatId)
            })
          } catch (err) {
            console.error("[chat] clone failed:", err)
          }
        })()
        return
      }
      if (r.action === "closeCurrentChat") {
        dbClient.update(root => {
          const ws = root.app.windowStates[windowId]
          if (!ws || ws.activeView.kind !== "workspace") return
          const scopeId = ws.selectedScopeId
          if (!scopeId) return
          const state = ws.scopePanes[scopeId]
          const pane = state?.panes.find(p =>
            p.tabs.some(t => t.content.kind === "chat" && t.content.chatId === chat.id),
          )
          const tab = pane?.tabs.find(
            t => t.content.kind === "chat" && t.content.chatId === chat.id,
          )
          if (!pane || !tab) return
          closeTabInRoot(root, windowId, scopeId, pane.id, tab.id)
        })
        return
      }
    }
  }

  const dispatchRegisteredSlashCommand = async (args: {
    command: RegisteredSlashCommand
    text: string
    argsText: string
  }) => {
    if (!chat) return
    type DynamicRpc = Record<
      string,
      Record<string, Record<string, (payload: Record<string, unknown>) => Promise<unknown>>>
    >
    const router = rpc as unknown as DynamicRpc
    const fn =
      router[args.command.rpc.plugin]?.[args.command.rpc.service]?.[
        args.command.rpc.method
      ]
    if (typeof fn !== "function") {
      console.error("[chat] slash command handler not found:", args.command)
      return
    }
    try {
      const result = await fn({
        windowId,
        chatId: chat.id,
        sessionId,
        command: args.command.name,
        text: args.text,
        argsText: args.argsText,
        ...(args.command.args ?? {}),
      })
      handleRegisteredSlashResult(result)
    } catch (err) {
      console.error("[chat] slash command failed:", args.command.name, err)
      toast.error(`/${args.command.name} failed`, {
        description: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const handleSlashAction = (action: string) => {
    if (!chat) return
    if (action.startsWith("registered:")) {
      const id = action.slice("registered:".length)
      const command = registeredSlashCommands[id]
      if (!command) return
      void dispatchRegisteredSlashCommand({
        command,
        text: `/${command.name}`,
        argsText: "",
      })
      return
    }
    if (action === "openWorkspace") {
      // Unlike `/tree` and `/fork`, `/workspace` does NOT require a
      // live session id — a pending chat still has a scope, and
      // moving it before the first prompt is a sensible flow
      // ("branch off before I start").
      setTreePanel({ kind: "workspace" })
      return
    }
    if (action === "openHandoff") {
      // `/worktree-handoff` also works on pending chats: the source
      // is the current chat's scope/worktree; we don't need an
      // active session to inspect git state.
      setTreePanel({ kind: "handoff" })
      return
    }
    if (action === "clone") {
      if (!sessionId) return
      // Clone now opens the new session in a SIBLING tab inside the
      // active pane (instead of replacing the active tab's chat).
      // The cloned session lives next to the original so the user
      // can switch between them — the cloning point is itself a
      // "branch and keep both" gesture.
      void (async () => {
        try {
          const result = await rpc.pi.sessions.clone({ sessionId })
          dbClient.update(root => {
            openChatInNewTabInRoot(root, windowId, result.chatId)
          })
        } catch (err) {
          console.error("[chat] clone failed:", err)
        }
      })()
      return
    }
    if (action === "lock") {
      // Direct replica update — see project rule on preferring replica
      // writes over RPC for instant feedback.
      dbClient.update(root => {
        const prev = root.app.chatStates[chat.id]
        root.app.chatStates[chat.id] = {
          chatId: chat.id,
          locked: true,
          draft: prev?.draft ?? "",
        }
      })
    } else if (action === "unlock") {
      dbClient.update(root => {
        const existing = root.app.chatStates[chat.id]
        if (existing) existing.locked = false
      })
    } else if (action === "set-default-steer") {
      dbClient.update(root => {
        root.app.settings.defaultSendMode = "steer"
      })
    } else if (action === "set-default-queue") {
      dbClient.update(root => {
        root.app.settings.defaultSendMode = "followUp"
      })
    }
  }

  const handleUnlock = () => {
    if (!chat) return
    dbClient.update(root => {
      const existing = root.app.chatStates[chat.id]
      if (existing) existing.locked = false
    })
  }

  const messages = useMemo(() => {
    if (!session) return []
    return materializeMessages(events, {
      directory: chatDirectory,
      extraDirectories: chatExtraDirectories,
      workspaceId: chatWorkspaceId,
      scopeId: chatScopeId,
    })
  }, [
    events,
    session,
    chatDirectory,
    chatExtraDirectories,
    chatWorkspaceId,
    chatScopeId,
  ])

  // Detector for the "sent a message, it didn't render" class of
  // bug. Calls into the renderer-side invariant store when an
  // expected user_prompt event or queueDraft entry doesn't show up
  // within the timeout. `track()` is invoked from handleSubmit
  // below right before the corresponding RPC.
  const deliveryInvariant = useMessageDeliveryInvariant({
    chatId: chat?.id ?? null,
    sessionId,
    events,
    queueDraft: session?.queueDraft ?? [],
    eventLogRef: (eventLogRef as unknown as
      | { collectionId: string; debugName: string }
      | null) ?? null,
  })

  // Live stats for the streaming "Xs, N tokens" footer.
  //
  // We read the context-window measurement (`stats.contextUsage.tokens`)
  // — the same value the context-view and status-bar already surface.
  // Subtracting the snapshot taken on `agent_start`
  // (`runStartContextTokens`) yields the tokens this run added to
  // the conversation. We intentionally do NOT use the billing
  // rollup `stats.tokens.input/output/...`: that field sums every
  // LLM call's `usage.input` and double-counts the growing context
  // across multi-turn (tool-call) runs, so it balloons WAY past
  // what the context view shows.
  //
  // Start timestamp: the wall-clock of the most recent user prompt
  // we've materialized. Loading derives elapsed seconds from this.
  const cumulativeContextTokens = session?.stats.contextUsage?.tokens ?? 0
  const baselineContextTokens =
    session?.runStartContextTokens ?? cumulativeContextTokens
  const loadingStats = useMemo(() => {
    let startTimestamp: number | null = null
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.role === "user" && m.timeSent) {
        startTimestamp = m.timeSent
        break
      }
    }
    // Clamp to >=0: if a turn lands before runStartContextTokens
    // is set (race on agent_start ordering), the subtraction would
    // briefly go negative.
    const tokens = Math.max(
      0,
      cumulativeContextTokens - baselineContextTokens,
    )
    return { startTimestamp, tokens }
  }, [messages, cumulativeContextTokens, baselineContextTokens])

  // Per-chat draft persistence. Returns "" + no-op handlers when
  // there's no chat yet (pre-empty-state); the hook itself guards
  // against writes to an empty chatId.
  const { initialText, onDraftChange, flushDraft } = useChatDraft(
    chat?.id ?? "",
  )

  const cornerClass = cornerRoundingClass({
    leftAdjacent,
    rightAdjacent,
    topAdjacent,
  })
  // We still draw the bottom border so the bottom edge of the shell stays
  // visible — the outer shell's `overflow-hidden rounded-[10px]` clips it
  // into the outer curve. What we *don't* draw is the bottom corner
  // rounding, because that would stack on top of the shell's curve.
  // When something sits above us (e.g. the tab bar), it owns the top
  // border too — otherwise we'd double up the line.
  void bottomAdjacent
  const borderClass = [
    topAdjacent ? null : "border-t",
    bottomAdjacent ? null : "border-b",
    rightAdjacent ? null : "border-r",
  ]
    .filter(Boolean)
    .join(" ")

  if (!chat) {
    return (
      <ChatEmptyState
        message="No chat selected."
        cornerClass={cornerClass}
        borderClass={borderClass}
      />
    )
  }

  const isReady = chat.session.kind === "ready" && !!session
  const streaming = isReady ? session.isStreaming : false
  const displayMessages = isReady
    ? messages
    : materializeMessages([], {
        directory: chatDirectory,
        extraDirectories: chatExtraDirectories,
        workspaceId: chatWorkspaceId,
        scopeId: chatScopeId,
      })

  const armAutoScrollOnNextUserPrompt = () => {
    if (!sessionId) return
    autoScrollTapCleanupRef.current?.()
    const baselineSeq = events.at(-1)?.seq ?? -1
    const eventLog = (dbClient as unknown as DbClientWithEventLog).pi.sessions[
      sessionId
    ]?.eventLog
    autoScrollTapCleanupRef.current =
      eventLog?.subscribeData(({ newItems }) => {
        if (
          !newItems.some(e => e.seq > baselineSeq && e.kind === "user_prompt")
        ) {
          return
        }
        autoScrollTapCleanupRef.current?.()
        autoScrollTapCleanupRef.current = null
        requestAnimationFrame(() => scrollToBottomRef.current?.())
      }) ?? null
  }

  const handleSubmit = async (payload: ComposerSubmitPayload) => {
    if (!isReady || !sessionId) return
    const slashText = payload.text.trim()
    if (slashText.startsWith("/")) {
      const withoutSlash = slashText.slice(1)
      const firstSpace = withoutSlash.search(/\s/)
      const commandName =
        firstSpace < 0 ? withoutSlash : withoutSlash.slice(0, firstSpace)
      const registered = Object.values(registeredSlashCommands).find(
        cmd => cmd.name === commandName,
      )
      if (registered) {
        await dispatchRegisteredSlashCommand({
          command: registered,
          text: slashText,
          argsText: firstSpace < 0 ? "" : withoutSlash.slice(firstSpace + 1),
        })
        return
      }
    }
    // Intent resolution:
    //   not streaming  → ignore intent, send as a regular prompt.
    //   streaming      → explicit intent wins; default is followUp.
    // Use the display text for invariant tracking — that's what the
    // user-message bubble (and queue-draft entry) actually persist,
    // so matching against `events`/`queueDraft` works.
    const trackedText = payload.displayText ?? payload.text
    if (!session.isStreaming) {
      deliveryInvariant.track(trackedText, "prompt")
      armAutoScrollOnNextUserPrompt()
      try {
        await rpc.pi.sessions.prompt({
          sessionId,
          text: payload.text,
          displayText: payload.displayText,
          images: payload.images,
          imageRefs: payload.imageRefs,
        })
      } catch (err) {
        autoScrollTapCleanupRef.current?.()
        autoScrollTapCleanupRef.current = null
        console.error("[chat] prompt failed:", err)
      }
      return
    }
    // Explicit intent (Mod-Enter, `/steer`, `/queue`) wins. Otherwise
    // fall back to the user's configured default send mode.
    const kind: "steer" | "followUp" =
      payload.intent === "steer" || payload.intent === "followUp"
        ? payload.intent
        : defaultSendMode
    deliveryInvariant.track(trackedText, "enqueue")
    try {
      await rpc.pi.sessions.enqueue({
        sessionId,
        text: payload.text,
        displayText: payload.displayText,
        images: payload.images,
        imageRefs: payload.imageRefs,
        kind,
      })
    } catch (err) {
      console.error("[chat] enqueue failed:", err)
    }
  }

  /**
   * Resolve the pi entry id for the Nth user message on the current
   * session path. Pulled on demand rather than cached so the bubble
   * always anchors to the right entry even if the tree changed
   * since the user last opened the chat. Returns `null` when the
   * index is out of range.
   */
  const resolveUserEntryId = async (
    userMessageIndex: number,
  ): Promise<string | null> => {
    if (!sessionId) return null
    const { entries, leafId } = await rpc.pi.sessions.getEntryTree({
      sessionId,
    })
    // Walk leaf → root, collect user messages, then reverse so
    // index 0 is the oldest user message on the current path.
    const byId = new Map(entries.map(e => [e.id, e] as const))
    const userPath: string[] = []
    let cur: string | null = leafId
    while (cur) {
      const e = byId.get(cur)
      if (!e) break
      if (e.kind === "message" && e.messageRole === "user") {
        userPath.push(e.id)
      }
      cur = e.parentId
    }
    userPath.reverse()
    return userPath[userMessageIndex] ?? null
  }

  /**
   * Edit-to-branch flow: rewind the session to before this user
   * message via `navigateTree` (with the chosen summary mode), then
   * ship the edited text as a fresh prompt on the same session.
   * Same tab, same chat, no session juggling — the materialized
   * message stream just rebuilds to drop the abandoned suffix and
   * stamp the new user message at the leaf.
   */
  const handleEditSubmit = async (args: {
    userMessageIndex: number
    text: string
    displayText: string
    choice: import("./lib/branch-summary-choice").BranchSummaryChoice
  }) => {
    if (!sessionId) return
    try {
      const entryId = await resolveUserEntryId(args.userMessageIndex)
      if (!entryId) {
        console.error(
          "[chat] handleEditSubmit: no user entry at index",
          args.userMessageIndex,
        )
        return
      }
      await rpc.pi.sessions.navigateTree({
        sessionId,
        entryId,
        summarize:
          args.choice.kind === "default" || args.choice.kind === "custom",
        customInstructions:
          args.choice.kind === "custom"
            ? args.choice.customInstructions
            : undefined,
      })
      await rpc.pi.sessions.prompt({
        sessionId,
        text: args.text,
        displayText: args.displayText,
      })
    } catch (err) {
      console.error("[chat] handleEditSubmit failed:", err)
    }
  }

  /**
   * Revert flow: rewind the session via `navigateTree` (with the
   * chosen summary mode), then emit `appendComposerDraft` so the
   * live composer picks up the picked message's text. Whatever the
   * user was already drafting stays put — the appended text lands
   * after a separating newline.
   *
   * navigateTree returns the picked entry's user text in
   * `editorText` when the target is a user message, which is
   * exactly what we want to drop into the composer.
   */
  const handleRevertSubmit = async (args: {
    userMessageIndex: number
    choice: import("./lib/branch-summary-choice").BranchSummaryChoice
  }) => {
    if (!sessionId || !chat) return
    try {
      const entryId = await resolveUserEntryId(args.userMessageIndex)
      if (!entryId) {
        console.error(
          "[chat] handleRevertSubmit: no user entry at index",
          args.userMessageIndex,
        )
        return
      }
      const result = await rpc.pi.sessions.navigateTree({
        sessionId,
        entryId,
        summarize:
          args.choice.kind === "default" || args.choice.kind === "custom",
        customInstructions:
          args.choice.kind === "custom"
            ? args.choice.customInstructions
            : undefined,
      })
      const text = result.editorText
      if (text == null || text.length === 0) return
      await rpc.pi.sessions.appendComposerDraft({
        composerId: chat.id,
        text,
      })
    } catch (err) {
      console.error("[chat] handleRevertSubmit failed:", err)
    }
  }

  /**
   * Open the side-by-side diff view in a split pane for the file
   * an `edit` / `write` tool call just (or is about to) touch.
   *
   * Routes through `rpc.app.gitTree.openDiff` — the same RPC the
   * git-tree sidebar and turn-summary cards use — so all three
   * land on the *same* diff tab via the `"git-tree-sidebar"`
   * source token baked into `openViewBySourceInWorkspaceInRoot`.
   * Clicking a second tool call replaces the diff pane's content
   * instead of stacking a new split.
   *
   * No-op when the chat has no live scope yet (fresh / pending
   * chat) — we'd have nothing meaningful to pass for
   * `workspaceId` / `scopeId`. The card stays non-interactive in
   * that case because materialize only stamps `editDirectory`
   * when there's a worktree to resolve against.
   */
  const handleOpenDiff = ({
    directory,
    path,
  }: {
    directory: string
    path: string
  }) => {
    if (!chatWorkspaceId || !chatScopeId) return
    void rpc.app.gitTree
      .openDiff({
        workspaceId: chatWorkspaceId,
        scopeId: chatScopeId,
        directory,
        path,
      })
      .catch(err => console.error("[chat] openDiff failed:", err))
  }

  /**
   * Open a tool-call's full output in a shared side pane. Routes
   * through `rpc.app.toolOutput.openOutput` — the same dance the
   * file sidebar / git tree sidebar use, just with a different
   * source token (`"chat-tool-output"`) so the output pane stays
   * distinct from the diff pane. Clicking a second tool-call card
   * replaces this pane's contents instead of spawning a new split.
   *
   * No-op when the chat has no live session yet (the view needs a
   * `sessionId` to subscribe to the eventLog), or when the chat
   * lacks a workspace / scope to route the pane through. The
   * BashCard's `onOpenToolOutput` prop stays undefined in that
   * case and the card renders non-interactive.
   */
  const handleOpenToolOutput = (toolCallId: string) => {
    if (!sessionId || !chatWorkspaceId || !chatScopeId) return
    void rpc.app.toolOutput
      .openOutput({
        workspaceId: chatWorkspaceId,
        scopeId: chatScopeId,
        sessionId,
        toolCallId,
      })
      .catch(err => console.error("[chat] openToolOutput failed:", err))
  }

  const resetLastUnansweredUserMessage = async (): Promise<void> => {
    if (!sessionId || !chat) return

    let lastUserMessageIndex: number | null = null
    let lastDisplayIndex: number | null = null
    for (let i = displayMessages.length - 1; i >= 0; i--) {
      const message = displayMessages[i]
      if (message?.role === "user" && message.userMessageIndex != null) {
        lastUserMessageIndex = message.userMessageIndex
        lastDisplayIndex = i
        break
      }
    }
    if (lastUserMessageIndex == null || lastDisplayIndex == null) return

    const hasModelActivity = displayMessages
      .slice(lastDisplayIndex + 1)
      .some(message => {
        if (message.role === "assistant" || message.role === "thinking") {
          return message.content.trim().length > 0
        }
        return (
          message.role === "tool" ||
          message.role === "plan" ||
          message.role === "permission_request"
        )
      })
    if (hasModelActivity) return

    const entryId = await resolveUserEntryId(lastUserMessageIndex)
    if (!entryId) return

    const result = await rpc.pi.sessions.navigateTree({
      sessionId,
      entryId,
      summarize: false,
    })
    const text = result.editorText
    if (text == null || text.length === 0) return
    await rpc.pi.sessions.appendComposerDraft({
      composerId: chat.id,
      text,
    })
  }

  const handleInterrupt = async () => {
    if (!isReady || !sessionId) return
    try {
      await rpc.pi.sessions.abort({ sessionId })
    } catch (err) {
      console.error("[chat] abort failed:", err)
      return
    }

    try {
      await resetLastUnansweredUserMessage()
    } catch (err) {
      console.error("[chat] reset unanswered user message failed:", err)
    }
  }

  const handleChangeModel = async (value: string) => {
    if (!isReady || !sessionId) return
    const slash = value.indexOf("/")
    if (slash < 0) return
    const provider = value.slice(0, slash)
    const id = value.slice(slash + 1)
    try {
      await rpc.pi.sessions.setModel({ sessionId, provider, id })
    } catch (err) {
      console.error("[chat] setModel failed:", err)
    }
  }

  const handleChangeThinking = async (value: string) => {
    if (!isReady || !sessionId) return
    try {
      await rpc.pi.sessions.setThinkingLevel({
        sessionId,
        level: value as Session["thinkingLevel"],
      })
    } catch (err) {
      console.error("[chat] setThinkingLevel failed:", err)
    }
  }

  return (
    <div
      className={cn(
        // No `bg-clip-padding`: when this pane draws its own `border-t`
        // (minimal mode, no chat-tabs above), letting `bg-background`
        // paint under the border keeps the seam composited against
        // the same surface as every other border in the app.
        "relative flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background",
        borderClass,
        cornerClass,
      )}
    >
      <ChatBackgroundLayer url={backgroundUrl} opacity={background?.opacity} />
      {showChatDevtools ? <InvariantOverlay chatId={chat.id} /> : null}
      <div className="relative z-10 flex min-h-0 flex-1 flex-col">
        <FileIndexContext.Provider value={files}>
        {/* Only render the chat's own title bar when nothing sits
         * above us. If a tab strip is above (`topAdjacent`), the tab
         * itself already carries the chat label — stacking a second
         * copy here would duplicate it. The only surface where
         * `topAdjacent` is false is the single-tab / no-split pane in
         * the main app, which is exactly where the title bar's
         * "what am I looking at?" affordance is missing today. */}
        {!topAdjacent ? (
          <ChatTitleBar
            chat={chat}
            sessionId={sessionId}
            hasOverflow={chatHasOverflow}
          />
        ) : null}
        <ErrorBoundary label="Chat">
          <ChatDisplay
            messages={displayMessages}
            streaming={streaming}
            loadingStats={loadingStats}
            scrollToBottomRef={scrollToBottomRef}
            onHasOverflowChange={setChatHasOverflow}
            onEditSubmit={handleEditSubmit}
            onRevertSubmit={handleRevertSubmit}
            onOpenDiff={handleOpenDiff}
            onOpenToolOutput={handleOpenToolOutput}
          />
        </ErrorBoundary>
        {sessionId && <QueuedMessages sessionId={sessionId} />}
        {chat && treePanelOpen ? (
          // The selector takes the composer's slot entirely while
          // open. Putting it side-by-side made focus state
          // ambiguous ("do my keys go to the tree or the input?")
          // — swapping the surface makes it unambiguous: if you can
          // see the selector, your keys go to the selector.
          //
          // Outer guard is `chat` (not `sessionId`) because the
          // `/workspace` panel works on pending chats too — it
          // only needs the chat's scope, not a live session.
          // `tree` / `fork` still require a sessionId and bail
          // out below if it's missing.
          <ErrorBoundary label="Selector">
            {treePanel.kind === "workspace" ? (
              <WorkspaceSelector
                scopeId={chat.scopeId}
                isStreaming={streaming}
                onConfirm={async ({ branch, worktreePath, commitFirst }) => {
                  try {
                    // The RPC owns the whole move transaction:
                    // optionally commit the source's pending
                    // changes, then `git worktree add`, abort any
                    // in-flight turn, dispose the live
                    // AgentSession, and flip chat.scopeId +
                    // session.scopeId. By the time it resolves,
                    // the chat is parked in the new worktree and
                    // the next prompt will re-activate pi with
                    // the new cwd.
                    await rpc.pi.sessions.moveToNewWorktree({
                      chatId: chat.id,
                      branch,
                      worktreePath,
                      windowId,
                      commitFirst,
                    })
                    setTreePanel({ kind: "closed" })
                  } catch (err) {
                    console.error(
                      "[chat] moveToNewWorktree failed:",
                      err,
                    )
                    // Re-throw so the selector keeps its panel
                    // open and surfaces the error inline.
                    throw err
                  }
                }}
                onCancel={() => setTreePanel({ kind: "closed" })}
              />
            ) : treePanel.kind === "handoff" ? (
              // `/worktree-handoff` panel — cross-worktree commit
              // transfer. Source is *this* chat's scope; the panel
              // picks the target from the same repo's worktrees.
              // The panel handles its own multi-stage flow
              // (pickTarget → preview/conflict → applying); the
              // chat-pane just provides callbacks to close on
              // success / agent-handoff.
              <WorktreeHandoffSelector
                chatId={chat.id}
                sourceScopeId={chat.scopeId}
                onCancel={() => setTreePanel({ kind: "closed" })}
                onClose={() => setTreePanel({ kind: "closed" })}
                onConflictHandedToComposer={() =>
                  setTreePanel({ kind: "closed" })
                }
              />
            ) : null}
          </ErrorBoundary>
        ) : modelOptions.length === 0 ? (
          // pi-commands panel state is owned by that plugin and read
          // by its composer-input advice directly from db; we don't
          // need a dedicated branch for it here anymore.
          // (Empty intentionally — see pi-commands plugin.)
          // No models means no provider has auth configured. We
          // swap the whole composer slot for the sign-in card —
          // the composer can't usefully render with an empty model
          // list, and the card is the only meaningful next step
          // anyway. The card vanishes the moment auth lands
          // because the model registry refreshes and `models`
          // becomes non-empty.
          <ErrorBoundary label="ChatAuthCard">
            <ChatAuthCard />
          </ErrorBoundary>
        ) : (
          <ErrorBoundary label="Composer">
            <Composer
              composerKey={chat.id}
              // Stamps this composer as `chat.id` so the bubble-side
              // revert flow can target it with an
              // `appendComposerDraft` event without clobbering live
              // drafts in other chats.
              composerId={chat.id}
              initialText={initialText}
              onDraftChange={onDraftChange}
              onSubmit={handleSubmit}
              files={files}
              slashCommands={slashCommands}
              onSlashAction={handleSlashAction}
              locked={locked}
              onUnlock={handleUnlock}
              streaming={streaming}
              onInterrupt={handleInterrupt}
              agentConfigs={agentConfigs}
              currentAgentConfigId={PI_AGENT_ID}
              currentModel={currentModelValue}
              onChangeModel={handleChangeModel}
              currentThinkingLevel={session?.thinkingLevel}
              onChangeThinkingLevel={handleChangeThinking}
            />
          </ErrorBoundary>
        )}
        {/* The footer strip. Chrome is host-owned; items are
          * contributed by plugins via `meta.kind = "pi-footer.item"`.
          * The built-in `scope-info` and `chat-stats` items live in
          * the `pi-footer` plugin and reach this slot through the
          * same registration path third-party items use. */}
        <PiFooter sessionId={sessionId} />
        </FileIndexContext.Provider>
      </div>
    </div>
  )
}

function ChatBackgroundLayer({
  url,
  opacity,
}: {
  url: string | null
  opacity: number | undefined
}) {
  if (!url) return null
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 z-0"
      style={{
        backgroundImage: `url(${url})`,
        backgroundSize: "cover",
        backgroundPosition: "center",
        backgroundRepeat: "no-repeat",
        opacity: opacity ?? 0.15,
      }}
    />
  )
}

function ChatEmptyState({
  message,
  cornerClass,
  borderClass,
}: {
  message: string
  cornerClass: string
  borderClass: string
}) {
  return (
    <div
      className={cn(
        "flex flex-1 items-center justify-center bg-background bg-clip-padding text-[12px] text-muted-foreground",
        borderClass,
        cornerClass,
      )}
    >
      {message}
    </div>
  )
}

function cornerRoundingClass(_args: {
  leftAdjacent: boolean
  rightAdjacent: boolean
  topAdjacent: boolean
}): string {
  // The outer app shell owns every window curve via
  // `overflow-hidden rounded-[10px]`, so the chat pane never rounds
  // its own corners. The seam against the title bar (when there's no
  // tab strip above us) is the pane's own `border-t` — a clean 1px
  // intersection line, matching the rest of the shell.
  void _args
  return ""
}
