import { useEffect, type ComponentType } from "react"
import { useInjection } from "@zenbujs/core/react"
import type { ChatWarmStatus, ChatWarmTarget } from "@/lib/chat-warm-targets"

export type ChatDataWarmerSlotProps = {
  targets: ChatWarmTarget[]
  activeChatId: string | null
  onStatusChange?: (status: ChatWarmStatus) => void
}

/** Data-only chat warmer injection seam.
 *
 * The app shell owns tab/window state, so it can cheaply identify likely
 * switch targets. The chat plugin owns event-log hydration and message
 * materialization, so the actual warming implementation stays behind this
 * optional injected component. If the chat plugin is unavailable, this is a
 * no-op; visible chat rendering still goes through `ChatPaneSlot`.
 */
export function ChatDataWarmerSlot(props: ChatDataWarmerSlotProps) {
  const ChatDataWarmer = useInjection<ComponentType<ChatDataWarmerSlotProps>>(
    "chat-data-warmer",
  )
  if (!ChatDataWarmer) {
    return <MissingChatDataWarmerSlot {...props} />
  }
  return (
    <>
      <span
        hidden
        data-chat-data-warmer-slot="ready"
        data-target-count={props.targets.length}
      />
      <ChatDataWarmer {...props} />
    </>
  )
}

function MissingChatDataWarmerSlot({
  targets,
  onStatusChange,
}: ChatDataWarmerSlotProps) {
  useEffect(() => {
    onStatusChange?.({
      activeChatId: null,
      queuedChatIds: [],
      completedChatIds: [],
      targetCount: targets.length,
    })
  }, [onStatusChange, targets.length])
  return (
    <span
      hidden
      data-chat-data-warmer-slot="missing"
      data-target-count={targets.length}
    />
  )
}
