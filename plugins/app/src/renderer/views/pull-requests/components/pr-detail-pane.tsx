import { useEffect, useMemo, useRef, useState } from "react"
import { useRpc } from "@zenbujs/core/react"
import { FileDiff as DiffsFileDiff } from "@pierre/diffs/react"
import { parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs"
import { Button } from "@zenbu/ui/button"
import { Spinner } from "@zenbu/ui/spinner"
import { cn } from "@/lib/utils"
import { ErrorBanner } from "./error-banner"
import type { PrDetails } from "../types"

const DIFF_STYLE: React.CSSProperties = {
  "--diffs-light-bg": "var(--background)",
  "--diffs-dark-bg": "var(--background)",
  "--diffs-light": "var(--foreground)",
  "--diffs-dark": "var(--foreground)",
  "--diffs-bg-buffer-override": "var(--background)",
  "--diffs-bg-context-override": "var(--background)",
  "--diffs-bg-context-gutter-override": "var(--background)",
  "--diffs-bg-separator-override": "var(--border)",
  // No `--diffs-font-family` override — the diff library picks the
  // host's body font on its own. Keeping a custom mono stack here
  // gave us a different font from the rest of the app, which read
  // as inconsistent.
  "--diffs-font-size": "12px",
  "--diffs-line-height": "18px",
  width: "100%",
  display: "block",
} as React.CSSProperties

/**
 * Detail page for a single PR. Left pane shows the metadata
 * (title, state, body, commit list, reviewer chips); right pane
 * shows the full PR diff fetched via `gh pr diff`.
 *
 * Read-only for now — review actions (approve, comment) would be a
 * follow-up. The "Open in browser" button is the escape hatch when
 * the user wants to actually do something with the PR.
 */
export function PrDetailPane({
  directory,
  prNumber,
  onBack,
}: {
  directory: string
  prNumber: number
  onBack: () => void
}) {
  const rpc = useRpc()
  const [pr, setPr] = useState<PrDetails | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [patch, setPatch] = useState<string | null>(null)
  const [patchError, setPatchError] = useState<string | null>(null)
  // `diffContainerRef` measures only the diff column (whose width
  // differs from the outer container in side-by-side mode), and
  // drives the split-vs-unified diff breakpoint. The side-by-side
  // vs stacked layout itself is handled purely in CSS via the
  // `@container` Tailwind utilities on the render tree below.
  const diffContainerRef = useRef<HTMLDivElement | null>(null)
  const [diffStyle, setDiffStyle] = useState<"split" | "unified">("unified")
  const themeType = useThemeType()

  useEffect(() => {
    let cancelled = false
    setPr(null)
    setError(null)
    setPatch(null)
    setPatchError(null)
    void rpc.app.github
      .getPullRequest({ directory, number: prNumber })
      .then(res => {
        if (cancelled) return
        if (res.ok) {
          setPr(res.pr)
        } else {
          setError(res.error)
        }
      })
    void rpc.app.github
      .getPullRequestDiff({ directory, number: prNumber })
      .then(res => {
        if (cancelled) return
        if (res.ok) {
          setPatch(res.patch)
        } else {
          setPatchError(res.error)
        }
      })
    return () => {
      cancelled = true
    }
  }, [directory, prNumber, rpc])

  // Diff-pane width observer — picks unified-vs-split *within* the
  // diff pane. Side-by-side diffs need roughly 920px of room to
  // read comfortably; below that we drop to a single column.
  useEffect(() => {
    const el = diffContainerRef.current
    if (!el) {
      setDiffStyle("unified")
      return
    }
    const update = (w: number) => setDiffStyle(w >= 920 ? "split" : "unified")
    update(el.clientWidth)
    const obs = new ResizeObserver(entries => {
      for (const e of entries) update(e.contentRect.width)
    })
    obs.observe(el)
    return () => obs.disconnect()
    // Re-run once the PR loads (the diff column only mounts after
    // `pr` is set). The node is stable across layout changes now
    // (CSS-only switch), so no re-attach on a layout breakpoint.
  }, [pr])

  const fileDiffs = useMemo<FileDiffMetadata[]>(() => {
    if (!patch) return []
    try {
      const parsed = parsePatchFiles(patch)
      const out: FileDiffMetadata[] = []
      for (const p of parsed) out.push(...p.files)
      return out
    } catch {
      return []
    }
  }, [patch])

  if (error) {
    return (
      <div className="flex h-full flex-col gap-3 p-4">
        <TopBar number={prNumber} onBack={onBack} url={null} />
        <ErrorBanner title="Could not load pull request" detail={error} />
      </div>
    )
  }

  if (!pr) {
    return (
      <div className="flex h-full flex-col">
        <TopBar number={prNumber} onBack={onBack} url={null} />
        <div className="flex flex-1 items-center justify-center text-muted-foreground">
          <Spinner size={16} />
        </div>
      </div>
    )
  }

  // Render the metadata block and the diff block in either layout.
  // The metadata gets its own scroller in side-by-side mode (so a
  // huge commit list doesn't push the diff offscreen), but in the
  // stacked layout the whole detail view scrolls as one continuous
  // page — metadata at the top, diff below — which feels right at
  // narrow widths.
  const metadata = (
    <div
      className={cn(
        "flex flex-col",
        // Padding lives on the metadata block itself so the wrapping
        // pane can decide whether to scroll independently or not.
        "p-4",
      )}
    >
      <div className="mb-2 flex items-baseline gap-2">
        <StateBadge state={pr.state} isDraft={pr.isDraft} />
        <span className="text-[11px] text-muted-foreground">
          #{pr.number}
        </span>
      </div>
      <h2 className="text-[15px] font-semibold leading-snug">
        {pr.title}
      </h2>
      <div className="mt-1 text-[11px] text-muted-foreground">
        <span>{pr.headRefName}</span> →{" "}
        <span>{pr.baseRefName}</span> · opened by {pr.author}
      </div>
      <Stats
        additions={pr.additions}
        deletions={pr.deletions}
        changedFiles={pr.changedFiles}
      />
      {pr.reviewers.length > 0 && (
        <div className="mt-3">
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
            Reviewers
          </div>
          <div className="mt-1 flex flex-wrap gap-1">
            {pr.reviewers.map(r => (
              <span
                key={r}
                className="rounded border bg-muted px-1.5 py-0.5 text-[11px]"
              >
                {r}
              </span>
            ))}
          </div>
        </div>
      )}
      {pr.body && (
        <div className="mt-4">
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
            Description
          </div>
          <pre className="mt-1 whitespace-pre-wrap rounded border bg-muted/30 p-3 text-[12px]">
            {pr.body.trim()}
          </pre>
        </div>
      )}
      {pr.commits.length > 0 && (
        <div className="mt-4">
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
            Commits ({pr.commits.length})
          </div>
          <ul className="mt-1 divide-y rounded border">
            {pr.commits.map(c => (
              <li key={c.sha} className="p-2 text-[12px]">
                <div className="flex items-baseline gap-2">
                  <span className="min-w-0 flex-1 truncate">
                    {c.subject}
                  </span>
                  <span className="shrink-0 text-[10px] text-muted-foreground">
                    {c.shortSha}
                  </span>
                </div>
                <div className="text-[11px] text-muted-foreground">
                  {c.authorName} ·{" "}
                  {new Date(c.authorDate).toLocaleString()}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )

  const diffBlock = (
    <div className="p-3">
      {patchError ? (
        <ErrorBanner title="Could not load PR diff" detail={patchError} />
      ) : patch == null ? (
        <div className="flex h-32 items-center justify-center text-muted-foreground">
          <Spinner size={16} />
        </div>
      ) : fileDiffs.length === 0 ? (
        <div className="p-3 text-[12px] text-muted-foreground">
          No textual differences.
        </div>
      ) : (
        fileDiffs.map((fd, i) => (
          <div key={i} className="mb-3 overflow-hidden rounded border">
            <DiffsFileDiff
              fileDiff={fd}
              options={{
                disableFileHeader: false,
                themeType,
                theme: { dark: "pierre-dark", light: "pierre-light" },
                diffStyle,
              }}
              style={DIFF_STYLE}
            />
          </div>
        ))
      )}
    </div>
  )

  // Layout responds to the *pane* width via Tailwind container-query
  // utilities: `@container` on the wrapper, then `@min-[1280px]:`
  // variants below. Above 1280px there's room for both the metadata
  // column (~360px) and a readable diff side-by-side, each scrolling
  // independently; below that the panes stack and the whole view
  // scrolls as one page (metadata first). The split-vs-unified diff
  // decision stays in JS — it's a prop on the diff component, which
  // CSS can't drive — and keys off the diff column's measured width.
  return (
    <div className="@container flex h-full min-h-0 flex-col">
      <TopBar number={pr.number} onBack={onBack} url={pr.url} />

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto @min-[1280px]:flex-row @min-[1280px]:overflow-hidden">
        <div className="min-w-0 @min-[1280px]:h-full @min-[1280px]:w-[360px] @min-[1280px]:shrink-0 @min-[1280px]:overflow-y-auto @min-[1280px]:border-r">
          {metadata}
        </div>
        <div
          ref={diffContainerRef}
          className="min-w-0 border-t bg-background @min-[1280px]:h-full @min-[1280px]:flex-1 @min-[1280px]:overflow-y-auto @min-[1280px]:border-t-0"
        >
          {diffBlock}
        </div>
      </div>
    </div>
  )
}

function TopBar({
  number,
  onBack,
  url,
}: {
  number: number
  onBack: () => void
  url: string | null
}) {
  return (
    <div className="flex h-8 shrink-0 items-center gap-2 overflow-hidden border-b px-3 text-[12px]">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={onBack}
        className="h-6 shrink-0 px-1.5 text-[11px]"
      >
        ← All PRs
      </Button>
      <span className="min-w-0 shrink truncate text-muted-foreground">
        PR #{number}
      </span>
      {url && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            const a = document.createElement("a")
            a.href = url
            a.target = "_blank"
            a.rel = "noopener noreferrer"
            a.click()
          }}
          className="ml-auto h-6 shrink-0 px-1.5 text-[11px]"
        >
          Open in browser
        </Button>
      )}
    </div>
  )
}

function Stats({
  additions,
  deletions,
  changedFiles,
}: {
  additions: number
  deletions: number
  changedFiles: number
}) {
  return (
    <div className="mt-3 flex items-center gap-3 text-[11px]">
      <span className="text-muted-foreground">
        {changedFiles} {changedFiles === 1 ? "file" : "files"} changed
      </span>
      <span className="text-green-600 dark:text-green-400">
        +{additions}
      </span>
      <span className="text-red-600 dark:text-red-400">
        −{deletions}
      </span>
    </div>
  )
}

function StateBadge({
  state,
  isDraft,
}: {
  state: PrDetails["state"]
  isDraft: boolean
}) {
  let label: string = state
  let cls = "bg-muted text-muted-foreground"
  if (isDraft) {
    label = "DRAFT"
    cls = "bg-muted text-muted-foreground"
  } else if (state === "OPEN") {
    cls = "bg-green-500/15 text-green-600 dark:text-green-400"
  } else if (state === "MERGED") {
    cls = "bg-purple-500/15 text-purple-600 dark:text-purple-400"
  } else if (state === "CLOSED") {
    cls = "bg-red-500/15 text-red-600 dark:text-red-400"
  }
  return (
    <span
      className={cn(
        "shrink-0 rounded px-1.5 py-0.5 text-[10px] uppercase",
        cls,
      )}
    >
      {label}
    </span>
  )
}

function useThemeType(): "light" | "dark" {
  const get = () =>
    document.documentElement.classList.contains("dark") ? "dark" : "light"
  const [type, setType] = useState<"light" | "dark">(get)
  useEffect(() => {
    const observer = new MutationObserver(() => setType(get()))
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    })
    return () => observer.disconnect()
  }, [])
  return type
}
