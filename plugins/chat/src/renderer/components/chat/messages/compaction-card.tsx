import { useState } from "react"
import { AlertCircle, Ban, Check, ChevronDown, ChevronUp, Loader2 } from "lucide-react"
import { Streamdown } from "streamdown"
import { cn } from "@/lib/utils"
import { streamdownProps } from "../lib/streamdown-config"
import type { CompactionCardProps } from "../message-components"

/**
 * System/status card for Pi context compaction. Covers the live
 * lifecycle (start → end) and historical markers rebuilt from
 * `compactionSummary` session messages.
 */
export function CompactionCard({
  reason,
  status,
  tokensBefore,
  willRetry,
  errorMessage,
  summary,
  firstKeptEntryId,
  readFiles,
  modifiedFiles,
}: CompactionCardProps) {
  const [expanded, setExpanded] = useState(false)
  const hasSummary = typeof summary === "string" && summary.trim().length > 0
  const fileCount = new Set([...(readFiles ?? []), ...(modifiedFiles ?? [])]).size

  return (
    <div className="px-3 py-2">
      <div
        className={cn(
          "rounded-md border px-3 py-2 text-sm shadow-sm",
          status === "failed" && "border-destructive/40 bg-destructive/5",
          status === "aborted" && "border-border/60 bg-muted/20",
          (status === "running" || status === "completed") &&
            "border-border/60 bg-card/40",
        )}
      >
        <div className="flex items-start gap-2">
          <StatusIcon status={status} />
          <div className="min-w-0 flex-1">
            <div className="font-medium text-foreground">{titleForStatus(status)}</div>
            {status === "running" ? (
              <div className="truncate text-xs text-muted-foreground">
                {reasonLabel(reason)}
              </div>
            ) : null}

            {status === "completed" && tokensBefore != null && tokensBefore > 0 ? (
              <div className="mt-0.5 text-xs text-muted-foreground">
                Before: {formatTokens(tokensBefore)} tokens
              </div>
            ) : null}

            {status === "completed" && willRetry ? (
              <div className="mt-0.5 text-xs text-muted-foreground">
                Pi will retry the request after compaction
              </div>
            ) : null}

            {status === "completed" && reason !== "unknown" ? (
              <div className="mt-0.5 text-xs text-muted-foreground">
                {reasonLabel(reason)}
              </div>
            ) : null}

            {status === "failed" && errorMessage ? (
              <div className="mt-1 text-xs text-destructive">{errorMessage}</div>
            ) : null}

            {status === "aborted" ? (
              <div className="mt-0.5 text-xs text-muted-foreground">
                Compaction was canceled before it finished
              </div>
            ) : null}

            {status === "completed" && fileCount > 0 ? (
              <div className="mt-0.5 text-xs text-muted-foreground">
                Tracked {fileCount} file{fileCount === 1 ? "" : "s"} in summary
              </div>
            ) : null}

            {status === "completed" && firstKeptEntryId ? (
              <div className="mt-1 truncate font-mono text-[10px] text-muted-foreground/80">
                kept from {shortId(firstKeptEntryId)}
              </div>
            ) : null}

            {status === "completed" && hasSummary ? (
              <div className="mt-2">
                <button
                  type="button"
                  onClick={() => setExpanded(v => !v)}
                  className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
                >
                  {expanded ? (
                    <>
                      <ChevronUp className="size-3.5" />
                      Hide summary
                    </>
                  ) : (
                    <>
                      <ChevronDown className="size-3.5" />
                      Show summary
                    </>
                  )}
                </button>
                {expanded ? (
                  <div className="mt-2 max-h-80 overflow-y-auto rounded border border-border/50 bg-background/60 px-3 py-2 text-[13px] leading-relaxed text-foreground">
                    <Streamdown {...streamdownProps}>{summary}</Streamdown>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )
}

function StatusIcon({ status }: { status: CompactionCardProps["status"] }) {
  if (status === "running") {
    return (
      <Loader2
        aria-hidden="true"
        className="mt-0.5 size-3.5 shrink-0 animate-spin text-muted-foreground"
      />
    )
  }
  if (status === "completed") {
    return (
      <Check
        aria-hidden="true"
        className="mt-0.5 size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400"
      />
    )
  }
  if (status === "failed") {
    return (
      <AlertCircle
        aria-hidden="true"
        className="mt-0.5 size-3.5 shrink-0 text-destructive"
      />
    )
  }
  return (
    <Ban aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
  )
}

function titleForStatus(status: CompactionCardProps["status"]): string {
  switch (status) {
    case "running":
      return "Compacting context…"
    case "completed":
      return "Context compacted"
    case "failed":
      return "Compaction failed"
    case "aborted":
      return "Compaction canceled"
    default:
      return "Compaction"
  }
}

function reasonLabel(reason: CompactionCardProps["reason"]): string {
  switch (reason) {
    case "manual":
      return "Manual request"
    case "threshold":
      return "Context window near limit"
    case "overflow":
      return "Context overflow; Pi will retry after compaction"
    default:
      return "Compaction requested"
  }
}

function formatTokens(count: number): string {
  if (count < 1000) return count.toString()
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`
  if (count < 1000000) return `${Math.round(count / 1000)}k`
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`
  return `${Math.round(count / 1000000)}M`
}

function shortId(id: string): string {
  if (id.length <= 12) return id
  return `${id.slice(0, 8)}…`
}
