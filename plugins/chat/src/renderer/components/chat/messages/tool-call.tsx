import type { ToolCallProps } from "../message-components"
import { ToolCallCard } from "./tool-call-card"

export function ToolCall(props: ToolCallProps) {
  return (
    <div className="px-3">
      <ToolCallCard {...props} />
    </div>
  )
}
