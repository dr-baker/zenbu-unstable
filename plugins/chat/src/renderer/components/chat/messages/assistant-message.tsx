import { Streamdown } from "streamdown"
import { streamdownProps } from "../lib/streamdown-config"
import type { AssistantMessageProps } from "../message-components"

export function AssistantMessage({ content }: AssistantMessageProps) {
  if (!content.trim()) return null
  return (
    <div className="py-1">
      <div className="min-w-0 overflow-hidden px-3 leading-relaxed text-foreground">
        <Streamdown {...streamdownProps}>{content}</Streamdown>
      </div>
    </div>
  )
}
