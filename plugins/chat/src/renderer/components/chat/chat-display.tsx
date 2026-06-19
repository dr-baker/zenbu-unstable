import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { MaterializedMessage } from "./lib/materialized-message"
import { useWindowedItems } from "./lib/use-windowed-items"
import { FindInChat } from "./find-in-chat"
import { Minimap } from "./minimap"
import { defaultMessageComponents } from "./messages"
import {
  MessageList,
  type LoadingStats,
  type MessageListHandle,
  type ScrollMetrics,
} from "./message-list"
import type { MessageComponents } from "./message-components"

export type ChatDisplayProps = {
  messages: MaterializedMessage[]
  streaming: boolean
  /** Live token / elapsed counters shown in the streaming footer.
   * Owned by chat-pane (it has the session + stats); chat-display
   * just forwards. */
  loadingStats: LoadingStats
  components?: Partial<MessageComponents>
  onPermissionSelect?: (requestId: string, optionId: string | "__cancel__") => void
  /** Fired when the user submits an in-place edit of a past user
   * message bubble. Forwarded into MessageList → UserMessage. */
  onEditSubmit?: (args: {
    userMessageIndex: number
    text: string
    displayText: string
    choice: import("./lib/branch-summary-choice").BranchSummaryChoice
  }) => void
  /** Fired when the user reverts to a past user message bubble. */
  onRevertSubmit?: (args: {
    userMessageIndex: number
    choice: import("./lib/branch-summary-choice").BranchSummaryChoice
  }) => void
  /** Fired when an `edit` / `write` tool-call card is clicked.
   * Chat-pane wires this to `rpc.app.gitTree.openDiff` with its
   * workspaceId + scopeId curried in so all tool clicks land in
   * the same diff pane (shared `"git-tree-sidebar"` source token). */
  onOpenDiff?: (args: { directory: string; path: string }) => void
  /** Fired when a tool-call card's output preview is clicked
   * (today: BashCard). Chat-pane wires this to
   * `rpc.app.toolOutput.openOutput` with sessionId + workspaceId +
   * scopeId curried in, opening the full output in a shared side
   * pane (`"chat-tool-output"` source token). */
  onOpenToolOutput?: (toolCallId: string) => void
  scrollToBottomRef?: React.MutableRefObject<(() => void) | null>
  /** Fires whenever the chat content's scroll overflow status
   * changes. Used by the chat-pane to suppress the title-bar fade
   * when there's nothing to scroll — a fresh "New Chat" pane has
   * no content below the bar, so the gradient would otherwise read
   * as a phantom shadow. */
  onHasOverflowChange?: (hasOverflow: boolean) => void
  initialWindow?: number
  batchSize?: number
}

export function ChatDisplay({
  messages: allMessages,
  streaming,
  loadingStats,
  components,
  onPermissionSelect,
  onEditSubmit,
  onRevertSubmit,
  onOpenDiff,
  onOpenToolOutput,
  scrollToBottomRef,
  onHasOverflowChange,
  initialWindow = 50,
  batchSize = 50,
}: ChatDisplayProps) {
  const mergedComponents = useMemo<MessageComponents>(
    () => ({ ...defaultMessageComponents, ...components }),
    [components],
  )

  const {
    items: messages,
    hasMoreBefore,
    hasMoreAfter,
    loadOlder,
    loadNewer,
    freezeTail,
    resumeTail,
  } = useWindowedItems({
    items: allMessages,
    initialWindow,
    batchSize,
  })

  const listRef = useRef<MessageListHandle>(null)
  const [scrollMetrics, setScrollMetrics] = useState<ScrollMetrics | null>(null)

  // Id of the most recent tool call across the *un-windowed*
  // message list. Threaded through MessageList → ToolCall →
  // BashCard so the last bash call can keep its output preview
  // open until the next tool call appears, at which point it
  // collapses to a click-to-open row — mirrors the
  // ThinkingBlock streaming → finished collapse, just keyed off
  // "a newer tool started" instead of "this tool finished".
  // Computed against `allMessages` (not `messages`) so windowing
  // doesn't mislabel an off-screen newer tool as absent.
  const lastToolCallId = useMemo(() => {
    for (let i = allMessages.length - 1; i >= 0; i--) {
      const m = allMessages[i]
      if (m.role === "tool") return m.toolCallId
    }
    return null
  }, [allMessages])

  // Standalone overflow detector for the title-bar fade. We can't
  // reuse `scrollMetrics` here — MessageList only emits those on
  // user scroll events, so a chat that becomes non-overflowing
  // (fork rewind, message removal) wouldn't update until the next
  // interaction. ResizeObserver on the scroll element + its content
  // wrapper gives us reactive overflow status independent of scroll.
  // 2px deadband to avoid flicker from subpixel rounding.
  useEffect(() => {
    if (!onHasOverflowChange) return
    const scrollEl = listRef.current?.getScrollElement() ?? null
    if (!scrollEl) return
    const contentEl = scrollEl.firstElementChild as HTMLElement | null
    let last = false
    const measure = () => {
      const next = scrollEl.scrollHeight - scrollEl.clientHeight > 2
      if (next !== last) {
        last = next
        onHasOverflowChange(next)
      }
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(scrollEl)
    if (contentEl) ro.observe(contentEl)
    return () => ro.disconnect()
  }, [onHasOverflowChange, messages.length])

  if (scrollToBottomRef) {
    scrollToBottomRef.current = () => {
      resumeTail()
      listRef.current?.forceScrollToBottom()
    }
  }

  const scrollElRef = useMemo<React.RefObject<HTMLDivElement | null>>(
    () => ({
      get current() {
        return listRef.current?.getScrollElement() ?? null
      },
      set current(_) {},
    }),
    [],
  )

  const handleScrollTo = useCallback((scrollTop: number) => {
    listRef.current?.scrollTo(scrollTop)
  }, [])

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      <FindInChat scrollRef={scrollElRef} contentVersion={messages.length} />
      <MessageList
        ref={listRef}
        messages={messages}
        loading={streaming}
        loadingStats={loadingStats}
        components={mergedComponents}
        onScrollMetrics={setScrollMetrics}
        hasMoreAbove={hasMoreBefore}
        hasMoreBelow={hasMoreAfter}
        onLoadOlder={loadOlder}
        onLoadNewer={loadNewer}
        onDetachedFromBottom={freezeTail}
        onReachedBottom={resumeTail}
        onPermissionSelect={onPermissionSelect}
        onEditSubmit={onEditSubmit}
        onRevertSubmit={onRevertSubmit}
        onOpenDiff={onOpenDiff}
        onOpenToolOutput={onOpenToolOutput}
        lastToolCallId={lastToolCallId}
      />
      <Minimap scrollMetrics={scrollMetrics} onScrollTo={handleScrollTo} />
    </div>
  )
}
