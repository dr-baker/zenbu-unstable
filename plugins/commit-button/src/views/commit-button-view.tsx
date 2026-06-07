import { useCallback, useEffect, useRef, useState } from "react"
import { useRpc, type ViewComponentProps } from "@zenbujs/core/react"
import { GitCommitVerticalIcon, GitPullRequestIcon } from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "@zenbu/ui/popover"
import { CommitPopoverBody } from "./commit-popover-body"

const POLL_MS = 3000

type LastCommit = {
  hash: string
  shortHash: string
  subject: string
  author: string
  relativeDate: string
} | null

export type Summary = {
  additions: number
  deletions: number
  changed: number
  untracked: number
  branch: string | null
  upstream: string | null
  ahead: number
  behind: number
  lastCommit: LastCommit
}

/** Title-bar args every `kind: "title-bar"` view receives. */
type TitleBarViewArgs = {
  workspaceId: string | null
  scopeId: string | null
  directory: string | null
}

type PopoverView = "menu" | "commit"

/**
 * Title-bar button that shows the working-tree diff size as `+a -d`
 * and opens a roomy commit/status popover on click.
 *
 * Polls the main process every few seconds while idle — git status
 * is cheap. While the popover is open we also let the popover drive
 * refresh after mutating actions (commit/pull/push/fetch).
 *
 * Plugin-contributed title-bar view: `directory` arrives in `args`
 * (resolved by the host from the active scope) rather than as a
 * direct prop the way it did when this lived in `plugins/app`.
 */
export default function CommitButtonView({
  args,
}: ViewComponentProps<TitleBarViewArgs>) {
  const directory = args?.directory ?? null
  const rpc = useRpc()
  const [summary, setSummary] = useState<Summary | null>(null)
  const [open, setOpen] = useState(false)
  const [view, setView] = useState<PopoverView>("menu")
  const inFlight = useRef(false)

  // Open the host's pull-requests pane view. Inlined here (was the
  // `useOpenPrView` hook in `plugins/app`) because we can't import
  // from the host's `@/` and it's just a single RPC call.
  const openPr = useCallback(() => {
    void rpc.app.github.openPullRequestsView({
      mode: "create",
      prNumber: null,
      directory,
      openMode: "split-right",
    })
  }, [rpc, directory])

  // Reset back to the menu whenever the popover closes so the next
  // click on the button starts from the action picker again,
  // instead of dropping the user straight back into the commit
  // form they were looking at last time.
  const handleOpenChange = useCallback((next: boolean) => {
    setOpen(next)
    if (!next) setView("menu")
  }, [])

  const refresh = useCallback(async () => {
    if (!directory) {
      setSummary(null)
      return
    }
    if (inFlight.current) return
    inFlight.current = true
    try {
      const s = await rpc.app.git.getStatusSummary({ directory })
      if (!s.ok || !s.isRepo) {
        setSummary(null)
      } else {
        setSummary({
          additions: s.additions,
          deletions: s.deletions,
          changed: s.changed,
          untracked: s.untracked,
          branch: s.branch,
          upstream: s.upstream,
          ahead: s.ahead,
          behind: s.behind,
          lastCommit: s.lastCommit,
        })
      }
    } catch {
      setSummary(null)
    } finally {
      inFlight.current = false
    }
  }, [directory, rpc])

  useEffect(() => {
    void refresh()
    const id = setInterval(() => {
      void refresh()
    }, POLL_MS)
    return () => clearInterval(id)
  }, [refresh])

  if (!directory) return null

  const additions = summary?.additions ?? 0
  const deletions = summary?.deletions ?? 0
  const untracked = summary?.untracked ?? 0
  const dirty =
    (summary?.changed ?? 0) > 0 ||
    untracked > 0 ||
    additions > 0 ||
    deletions > 0

  if (!dirty) return null

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={
            summary
              ? `${summary.branch ?? "detached"} — ${summary.changed} changed${
                  untracked ? `, ${untracked} untracked` : ""
                }`
              : "Commit"
          }
          className={
            "group inline-flex h-[22px] items-center gap-1.5 rounded-md border border-border bg-background/40 " +
            "px-2 text-[11px] font-medium leading-none transition-colors " +
            "hover:bg-background/70 " +
            "data-[state=open]:bg-background/80 " +
            (dirty ? "text-foreground" : "text-muted-foreground")
          }
        >
          <GitCommitVerticalIcon className="h-3.5 w-3.5 opacity-80" />
          <span className="flex items-center gap-1 tabular-nums">
            <span className="text-emerald-500 dark:text-emerald-400">
              +{additions}
            </span>
            <span className="text-rose-500 dark:text-rose-400">
              −{deletions}
            </span>
            {untracked > 0 && (
              <span className="text-muted-foreground">·{untracked}</span>
            )}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={6}
        className={view === "menu" ? "w-[160px] p-1" : "w-[460px] p-0"}
      >
        {view === "menu" ? (
          <ActionMenu
            onCommit={() => setView("commit")}
            onPr={() => {
              setOpen(false)
              openPr()
            }}
          />
        ) : (
          <CommitPopoverBody
            directory={directory}
            open={open}
            summary={summary}
            onRefreshSummary={refresh}
            onClose={() => setOpen(false)}
          />
        )}
      </PopoverContent>
    </Popover>
  )
}

function ActionMenu({
  onCommit,
  onPr,
}: {
  onCommit: () => void
  onPr: () => void
}) {
  return (
    <div className="flex flex-col">
      <ActionMenuItem
        icon={<GitCommitVerticalIcon className="h-3.5 w-3.5" />}
        label="Commit"
        onClick={onCommit}
      />
      <ActionMenuItem
        icon={<GitPullRequestIcon className="h-3.5 w-3.5" />}
        label="Pull request"
        onClick={onPr}
      />
    </div>
  )
}

function ActionMenuItem({
  icon,
  label,
  onClick,
}: {
  icon: React.ReactNode
  label: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "group flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-[12px] " +
        "transition-colors hover:bg-accent hover:text-accent-foreground"
      }
    >
      <span className="text-muted-foreground group-hover:text-accent-foreground">
        {icon}
      </span>
      <span className="flex-1 truncate font-medium">{label}</span>
    </button>
  )
}
