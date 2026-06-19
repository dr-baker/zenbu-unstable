import { useState } from "react"
import { Streamdown } from "streamdown"
import { Button } from "@zenbu/ui/button"
import { cn } from "@/lib/utils"
import { streamdownProps } from "../lib/streamdown-config"
import type { ThinkingBlockProps } from "../message-components"

export function ThinkingBlock({ content, streaming }: ThinkingBlockProps) {
  const [expanded, setExpanded] = useState(false)
  if (!content.trim()) return null

  if (streaming) {
    return (
      <div className="min-w-0 overflow-hidden px-3 text-xs leading-relaxed text-muted-foreground">
        <Streamdown {...streamdownProps}>{content}</Streamdown>
      </div>
    )
  }

  return (
    <div className="px-3">
      <Button
        type="button"
        variant="ghost"
        onClick={() => setExpanded(e => !e)}
        className="group/thought h-auto w-full min-w-0 justify-start gap-1.5 rounded-none bg-transparent px-0 py-0.5 text-left text-sm font-normal hover:bg-transparent has-[>svg]:px-0"
      >
        <span className="shrink-0 text-muted-foreground">Thought</span>
        <Chevron expanded={expanded} />
      </Button>
      {expanded && (
        <div className="mt-1 min-w-0 overflow-hidden text-xs leading-relaxed text-muted-foreground">
          <Streamdown {...streamdownProps}>{content}</Streamdown>
        </div>
      )}
    </div>
  )
}

function Chevron({ expanded }: { expanded: boolean }) {
  return (
    <svg
      className={cn(
        "shrink-0 text-muted-foreground transition-opacity",
        expanded ? "opacity-100" : "opacity-0 group-hover/thought:opacity-100",
      )}
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ transform: expanded ? "rotate(90deg)" : undefined }}
    >
      <path d="M4.5 3L7.5 6L4.5 9" />
    </svg>
  )
}
