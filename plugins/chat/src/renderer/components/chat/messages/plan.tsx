import { cn } from "@/lib/utils"
import type { PlanProps } from "../message-components"

export function Plan({ entries }: PlanProps) {
  return (
    <div className="w-full px-3">
      <div className="mb-1.5 text-[12px] font-medium text-muted-foreground">
        Plan
      </div>
      <div className="flex flex-col">
        {entries.map((entry, i) => (
          <label
            key={i}
            className="flex cursor-default items-start gap-2.5 py-1"
          >
            <span className="mt-[3px]">
              <PlanCheckbox status={entry.status} />
            </span>
            <span
              className={cn(
                "text-[13px] leading-[1.45]",
                entry.status === "completed" &&
                  "text-muted-foreground line-through",
                entry.status === "in_progress" &&
                  "font-medium text-foreground",
                entry.status === "failed" && "text-red-600",
                entry.status !== "completed" &&
                  entry.status !== "in_progress" &&
                  entry.status !== "failed" &&
                  "text-foreground",
              )}
            >
              {entry.content}
            </span>
          </label>
        ))}
      </div>
    </div>
  )
}

function PlanCheckbox({ status }: { status: string }) {
  if (status === "in_progress") {
    return (
      <span className="relative h-3.5 w-3.5 shrink-0 rounded-[3px] border border-muted-foreground">
        <span className="absolute inset-0 animate-spin-slow rounded-[3px] border border-transparent border-t-foreground" />
      </span>
    )
  }
  if (status === "completed") {
    return (
      <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[3px] bg-foreground">
        <svg
          className="h-2.5 w-2.5 text-background"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={3.5}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M5 13l4 4L19 7"
          />
        </svg>
      </span>
    )
  }
  if (status === "failed") {
    return (
      <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[3px] border border-red-400">
        <svg
          className="h-2.5 w-2.5 text-red-500"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={3.5}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M6 18L18 6M6 6l12 12"
          />
        </svg>
      </span>
    )
  }
  return (
    <span className="h-3.5 w-3.5 shrink-0 rounded-[3px] border border-border" />
  )
}
