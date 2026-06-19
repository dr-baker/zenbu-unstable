import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react"
import { ArrowDownIcon } from "lucide-react"
import { Button } from "@zenbu/ui/button"
import { cn } from "@/lib/utils"
import type { MaterializedMessage } from "./lib/materialized-message"
import { useAutoScroll, type ScrollSnapshot } from "./lib/use-auto-scroll"
import type { MessageComponents } from "./message-components"

export type ScrollMetrics = {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  clientWidth: number
}

export type MessageListHandle = {
  isLockedToBottom: boolean
  getScrollMetrics: () => ScrollMetrics | null
  scrollTo: (scrollTop: number) => void
  getScrollElement: () => HTMLDivElement | null
  forceScrollToBottom: () => void
}

export type LoadingStats = {
  startTimestamp: number | null
  tokens: number
}

export type MessageListProps = {
  messages: MaterializedMessage[]
  loading: boolean
  /** Live counters for the streaming footer. Only read while `loading`
   * is true; chat-pane computes it from `session.stats` and
   * `session.runStartTokens`. */
  loadingStats: LoadingStats
  components: MessageComponents
  onScrollMetrics?: (metrics: ScrollMetrics) => void
  hasMoreAbove?: boolean
  hasMoreBelow?: boolean
  onLoadOlder?: (captureSnapshot: () => ScrollSnapshot | null) => void
  onLoadNewer?: () => void
  onDetachedFromBottom?: () => void
  onReachedBottom?: () => void
  onPermissionSelect?: (requestId: string, optionId: string | "__cancel__") => void
  /** Forwarded straight through to `<C.UserMessage>`. The chat-pane
   * is the source of truth for entry id → session resolution, so
   * the list itself stays oblivious. */
  onEditSubmit?: (args: {
    userMessageIndex: number
    text: string
    displayText: string
    choice: import("./lib/branch-summary-choice").BranchSummaryChoice
  }) => void
  /** Forwarded straight through to `<C.UserMessage>`. */
  onRevertSubmit?: (args: {
    userMessageIndex: number
    choice: import("./lib/branch-summary-choice").BranchSummaryChoice
  }) => void
  /** Forwarded straight through to `<C.ToolCall>` for `edit` /
   * `write` cards. Chat-pane curries in workspace + scope ids and
   * fires `rpc.app.gitTree.openDiff` so all tool-card clicks land
   * in the same diff pane (shared with the sidebar / turn-summary
   * via the `"git-tree-sidebar"` source token). */
  onOpenDiff?: (args: { directory: string; path: string }) => void
  /** Forwarded to BashCard (today) so clicking a tool-call preview
   * opens the full output in a shared side pane (source token
   * `"chat-tool-output"`). Chat-pane curries in sessionId +
   * workspace + scope. */
  onOpenToolOutput?: (toolCallId: string) => void
  /** Id of the most recent tool call in the (un-windowed) chat.
   * The matching `MessageRow` flips `isLastToolCall` on so
   * BashCard knows to keep its output preview open; every prior
   * tool call gets `false` and collapses to a click-to-open row.
   * See chat-display for the rationale on computing this against
   * the full message list. */
  lastToolCallId?: string | null
}

const MIN_LOAD_OLDER_THRESHOLD = 400
const LOAD_OLDER_THRESHOLD_MULTIPLIER = 1.5
const LOAD_NEWER_THRESHOLD = 200

function getLoadOlderThreshold(el: HTMLElement) {
  return Math.max(
    MIN_LOAD_OLDER_THRESHOLD,
    Math.round(el.clientHeight * LOAD_OLDER_THRESHOLD_MULTIPLIER),
  )
}

function getMessageKey(msg: MaterializedMessage, index: number): string {
  if (msg.key) return msg.key
  switch (msg.role) {
    case "tool":
      return `tool-${msg.toolCallId}`
    case "permission_request":
      return `perm-${msg.requestId}`
    case "plan":
      return `plan-${index}`
    case "turn_summary":
      return `turn-${index}`
    case "interrupted":
      return `interrupted-${index}`
    case "error":
      return `error-${index}`
    case "system_reload":
      return `system-reload-${index}`
    default:
      return `${msg.role}-${index}`
  }
}

export const MessageList = forwardRef<MessageListHandle, MessageListProps>(
  function MessageList(
    {
      messages,
      loading,
      loadingStats,
      components: C,
      onScrollMetrics,
      hasMoreAbove,
      hasMoreBelow,
      onLoadOlder,
      onLoadNewer,
      onDetachedFromBottom,
      onReachedBottom,
      onPermissionSelect,
      onEditSubmit,
      onOpenDiff,
      onOpenToolOutput,
      onRevertSubmit,
      lastToolCallId,
    },
    ref,
  ) {
    const autoScroll = useAutoScroll({
      working: !!loading,
      canLockToBottom: !hasMoreBelow,
      onUserScrolled: onDetachedFromBottom,
    })
    const initialScrollDoneRef = useRef(false)
    const pendingSnapshotRef = useRef<ScrollSnapshot | null>(null)
    const loadOlderInFlightRef = useRef(false)
    const [showScrollToBottom, setShowScrollToBottom] = useState(false)
    const clickedScrollToBottomRef = useRef(false)

    const emitScrollMetrics = useCallback(() => {
      const el = autoScroll.getScrollElement()
      if (!el || !onScrollMetrics) return
      onScrollMetrics({
        scrollTop: el.scrollTop,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
        clientWidth: el.clientWidth,
      })
    }, [onScrollMetrics, autoScroll])

    const handleScroll = useCallback(() => {
      const el = autoScroll.getScrollElement()
      if (!el) return
      const wasUserScrolled = autoScroll.userScrolled
      const distanceFromBottom = el.scrollHeight - el.clientHeight - el.scrollTop
      const loadOlderThreshold = getLoadOlderThreshold(el)

      if (
        hasMoreBelow &&
        wasUserScrolled &&
        distanceFromBottom < LOAD_NEWER_THRESHOLD
      ) {
        onLoadNewer?.()
        emitScrollMetrics()
        return
      }

      autoScroll.handleScroll()
      emitScrollMetrics()

      const isUserScrolled = autoScroll.userScrolled
      if (!isUserScrolled) loadOlderInFlightRef.current = false

      if (
        hasMoreAbove &&
        onLoadOlder &&
        isUserScrolled &&
        !loadOlderInFlightRef.current &&
        el.scrollTop < loadOlderThreshold
      ) {
        const capture = () => {
          loadOlderInFlightRef.current = true
          const snap = autoScroll.captureSnapshot()
          if (snap) pendingSnapshotRef.current = snap
          return snap
        }
        onLoadOlder(capture)
      }

      if (wasUserScrolled && !isUserScrolled && !hasMoreBelow) {
        onReachedBottom?.()
      }

      const shouldShow = distanceFromBottom > 4
      if (shouldShow) clickedScrollToBottomRef.current = false
      setShowScrollToBottom(shouldShow)
    }, [
      autoScroll,
      emitScrollMetrics,
      hasMoreAbove,
      hasMoreBelow,
      onLoadNewer,
      onLoadOlder,
      onReachedBottom,
    ])

    useLayoutEffect(() => {
      const el = autoScroll.getScrollElement()
      if (!el) return
      const distanceFromBottom = el.scrollHeight - el.clientHeight - el.scrollTop
      if (distanceFromBottom > LOAD_NEWER_THRESHOLD) return
      if (hasMoreBelow) {
        if (autoScroll.userScrolled) onLoadNewer?.()
        else onReachedBottom?.()
        return
      }
      if (autoScroll.userScrolled && distanceFromBottom <= 4) {
        onReachedBottom?.()
      }
    }, [autoScroll, hasMoreBelow, messages.length, onLoadNewer, onReachedBottom])

    useLayoutEffect(() => {
      if (pendingSnapshotRef.current) return
      if (autoScroll.userScrolled) return
      autoScroll.forceScrollToBottom()
    }, [autoScroll, messages])

    useLayoutEffect(() => {
      if (initialScrollDoneRef.current) return
      if (messages.length === 0) return
      const el = autoScroll.getScrollElement()
      if (!el) return
      el.scrollTop = el.scrollHeight
      initialScrollDoneRef.current = true
    }, [messages.length, autoScroll])

    useLayoutEffect(() => {
      const snapshot = pendingSnapshotRef.current
      if (!snapshot) return
      pendingSnapshotRef.current = null
      autoScroll.restoreSnapshot(snapshot)
      loadOlderInFlightRef.current = false
    }, [messages, autoScroll])

    useImperativeHandle(
      ref,
      () => ({
        get isLockedToBottom() {
          return !autoScroll.userScrolled
        },
        getScrollMetrics: () => {
          const el = autoScroll.getScrollElement()
          if (!el) return null
          return {
            scrollTop: el.scrollTop,
            scrollHeight: el.scrollHeight,
            clientHeight: el.clientHeight,
            clientWidth: el.clientWidth,
          }
        },
        scrollTo: (scrollTop: number) => {
          const el = autoScroll.getScrollElement()
          if (el) el.scrollTop = scrollTop
        },
        getScrollElement: () => autoScroll.getScrollElement(),
        forceScrollToBottom: () => autoScroll.forceScrollToBottom(),
      }),
      [autoScroll],
    )

    return (
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={autoScroll.scrollRef}
          onScroll={handleScroll}
          onClick={autoScroll.handleInteraction}
          className={`min-h-0 flex-1 overflow-y-auto px-6 pt-3 pb-1 [scrollbar-width:none] ${
            autoScroll.userScrolled
              ? "hover:[scrollbar-width:thin] hover:[scrollbar-color:rgba(0,0,0,0.18)_transparent]"
              : ""
          }`}
          style={{ overflowX: "hidden" }}
        >
          <div
            ref={autoScroll.contentRef}
            className="mx-auto w-full max-w-[919px] space-y-1.5"
          >
            {hasMoreAbove && (
              <div className="flex justify-center py-2">
                <span className="animate-pulse text-xs text-muted-foreground">
                  Loading…
                </span>
              </div>
            )}

            {messages.map((msg, i) => (
              <MessageRow
                key={getMessageKey(msg, i)}
                message={msg}
                components={C}
                onPermissionSelect={onPermissionSelect}
                onEditSubmit={onEditSubmit}
                onRevertSubmit={onRevertSubmit}
                onOpenDiff={onOpenDiff}
                onOpenToolOutput={onOpenToolOutput}
                lastToolCallId={lastToolCallId}
              />
            ))}

            {loading && (
              <div className="shrink-0 h-9">
                <C.Loading
                  startTimestamp={loadingStats.startTimestamp}
                  tokens={loadingStats.tokens}
                />
              </div>
            )}
            {!loading && messages.length > 0 && (
              <div className="shrink-0 min-h-9 pb-4" />
            )}
          </div>
        </div>

        <Button
          variant="outline"
          size="icon-sm"
          onClick={() => {
            clickedScrollToBottomRef.current = true
            setShowScrollToBottom(false)
            onReachedBottom?.()
            autoScroll.forceScrollToBottom()
          }}
          className={cn(
            "absolute bottom-4 left-1/2 z-10 -translate-x-1/2 rounded-lg bg-card text-muted-foreground shadow-md transition-opacity",
            showScrollToBottom
              ? "opacity-100"
              : "pointer-events-none opacity-0",
          )}
        >
          <ArrowDownIcon className="size-4" />
        </Button>
      </div>
    )
  },
)

function MessageRow({
  message,
  components: C,
  onPermissionSelect,
  onEditSubmit,
  onRevertSubmit,
  onOpenDiff,
  onOpenToolOutput,
  lastToolCallId,
}: {
  message: MaterializedMessage
  components: MessageComponents
  onPermissionSelect?: (requestId: string, optionId: string | "__cancel__") => void
  onEditSubmit?: (args: {
    userMessageIndex: number
    text: string
    displayText: string
    choice: import("./lib/branch-summary-choice").BranchSummaryChoice
  }) => void
  onRevertSubmit?: (args: {
    userMessageIndex: number
    choice: import("./lib/branch-summary-choice").BranchSummaryChoice
  }) => void
  onOpenDiff?: (args: { directory: string; path: string }) => void
  onOpenToolOutput?: (toolCallId: string) => void
  lastToolCallId?: string | null
}) {
  switch (message.role) {
    case "user":
      return (
        <C.UserMessage
          content={message.content}
          images={message.images}
          userMessageIndex={message.userMessageIndex}
          onEditSubmit={onEditSubmit}
          onRevertSubmit={onRevertSubmit}
        />
      )
    case "assistant":
      return <C.AssistantMessage content={message.content} />
    case "thinking":
      return (
        <C.ThinkingBlock
          content={message.content}
          streaming={message.streaming}
        />
      )
    case "tool":
      return (
        <C.ToolCall
          toolCallId={message.toolCallId}
          title={message.title}
          subtitle={message.subtitle}
          kind={message.kind}
          status={message.status}
          contentItems={message.contentItems}
          toolName={message.toolName}
          rawInput={message.rawInput}
          rawOutput={message.rawOutput}
          toolResponse={message.toolResponse}
          argsComplete={message.argsComplete}
          editPath={message.editPath}
          editDirectory={message.editDirectory}
          onOpenDiff={onOpenDiff}
          onOpenToolOutput={onOpenToolOutput}
          isLastToolCall={message.toolCallId === lastToolCallId}
        />
      )
    case "plan":
      return <C.Plan entries={message.entries} />
    case "permission_request":
      return (
        <C.PermissionRequest
          requestId={message.requestId}
          title={message.title}
          description={message.description}
          options={message.options}
          responded={message.responded}
          onSelect={optionId =>
            onPermissionSelect?.(message.requestId, optionId)
          }
        />
      )
    case "interrupted":
      return <C.Interrupted />
    case "system_reload":
      return <C.AgentReloaded />
    case "clone_marker":
      return (
        <C.CloneMarker
          variant={message.variant}
          parentSessionId={message.parentSessionId}
          parentTitle={message.parentTitle}
          parentEntryId={message.parentEntryId}
          timestamp={message.timestamp}
        />
      )
    case "turn_summary":
      return (
        <C.TurnSummary
          files={message.files}
          directory={message.directory}
          workspaceId={message.workspaceId}
          scopeId={message.scopeId}
        />
      )
    case "error":
      return (
        <C.ErrorMessage message={message.message} detail={message.detail} />
      )
  }
}
