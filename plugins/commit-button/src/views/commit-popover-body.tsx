import { useCallback, useEffect, useState } from "react"
import { useRpc } from "@zenbujs/core/react"
import { GitBranchIcon } from "lucide-react"
import type { Summary } from "./commit-button-view"

type PreviewFile = {
  path: string
  oldPath: string | null
  status: string
  additions: number
  deletions: number
  binary: boolean
}

type Preview = {
  branch: string | null
  files: PreviewFile[]
  additions: number
  deletions: number
}

export type CommitPopoverBodyProps = {
  directory: string
  open: boolean
  summary: Summary | null
  onRefreshSummary: () => Promise<void> | void
  onClose: () => void
}

export function CommitPopoverBody({
  directory,
  open,
  summary,
  onRefreshSummary,
  onClose,
}: CommitPopoverBodyProps) {
  const rpc = useRpc()
  const [preview, setPreview] = useState<Preview | null>(null)
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [committing, setCommitting] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const p = await rpc.app.git.getCommitPreview({ directory })
      if (!p.ok || !p.isRepo) {
        setPreview(null)
        setError("Not a git repository")
        return
      }
      setPreview({
        branch: p.branch,
        files: p.files as PreviewFile[],
        additions: p.additions,
        deletions: p.deletions,
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setPreview(null)
    } finally {
      setLoading(false)
    }
  }, [directory, rpc])

  useEffect(() => {
    if (!open) return
    setMessage("")
    setError(null)
    setCommitting(false)
    setPreview(null)
    void load()
  }, [open, load])

  const handleCommit = async (e?: React.FormEvent) => {
    e?.preventDefault()
    const trimmed = message.trim()
    if (!trimmed || committing) return
    setCommitting(true)
    setError(null)
    try {
      const result = await rpc.app.git.commit({
        directory,
        message: trimmed,
      })
      if (!result.ok) {
        setError(result.error)
        return
      }
      setMessage("")
      await Promise.all([load(), onRefreshSummary()])
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setCommitting(false)
    }
  }

  const fileCount = preview?.files.length ?? 0
  const canCommit = !!message.trim() && fileCount > 0 && !committing
  const branch = preview?.branch ?? summary?.branch ?? null

  return (
    <form onSubmit={handleCommit} className="flex flex-col">
      {/* Header: branch only */}
      <div className="flex items-center gap-1.5 border-b px-3 py-2 text-[12px]">
        <GitBranchIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate font-medium">
          {branch ?? "detached HEAD"}
        </span>
        {preview && fileCount > 0 && (
          <span className="ml-auto flex items-center gap-2 text-[11px] tabular-nums">
            <span className="text-muted-foreground">
              {fileCount} file{fileCount === 1 ? "" : "s"}
            </span>
            <span className="text-emerald-500 dark:text-emerald-400">
              +{preview.additions}
            </span>
            <span className="text-rose-500 dark:text-rose-400">
              −{preview.deletions}
            </span>
          </span>
        )}
      </div>

      {/* File list */}
      <div className="max-h-[280px] min-h-[60px] overflow-y-auto">
        {loading && fileCount === 0 && (
          <div className="px-3 py-6 text-center text-[12px] text-muted-foreground">
            Loading…
          </div>
        )}
        {!loading && fileCount === 0 && !error && (
          <div className="px-3 py-6 text-center text-[12px] text-muted-foreground">
            No changes
          </div>
        )}
        {preview?.files.map(f => (
          <FileRow key={f.path} file={f} />
        ))}
      </div>

      {/* Footer composer — no container, looks like the footer itself */}
      <div className="flex flex-col border-t">
        <textarea
          autoFocus
          placeholder="Commit message"
          value={message}
          onChange={e => setMessage(e.target.value)}
          rows={2}
          className="w-full resize-none border-0 bg-transparent px-3 py-2.5 text-[12.5px] leading-snug outline-none placeholder:text-muted-foreground focus:ring-0"
          onKeyDown={e => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              void handleCommit()
            }
          }}
        />

        {error && (
          <p className="px-3 pb-2 text-[11.5px] text-destructive whitespace-pre-wrap">
            {error}
          </p>
        )}

        <div className="flex items-center justify-end gap-2 px-3 pb-2.5">
          <button
            type="submit"
            disabled={!canCommit}
            className={
              "inline-flex h-7 items-center rounded-md px-3 text-[11.5px] font-medium transition-colors " +
              "bg-foreground text-background hover:bg-foreground/90 " +
              "disabled:bg-muted disabled:text-muted-foreground disabled:cursor-not-allowed"
            }
          >
            {committing ? "Committing…" : "Commit"}
          </button>
        </div>
      </div>
    </form>
  )
}

function FileRow({ file }: { file: PreviewFile }) {
  const label = statusLabel(file.status)
  return (
    <div className="flex items-center gap-2 px-3 py-1 text-[12px]">
      <span
        className={
          "w-3 shrink-0 text-center text-[10px] font-semibold " +
          label.className
        }
        aria-label={label.title}
      >
        {label.glyph}
      </span>
      <span
        className="flex-1 truncate text-[12px]"
        aria-label={file.path}
      >
        {file.oldPath ? (
          <span className="text-muted-foreground">{file.oldPath} → </span>
        ) : null}
        {file.path}
      </span>
      {file.binary ? (
        <span className="text-[11px] text-muted-foreground tabular-nums">
          binary
        </span>
      ) : (
        <span className="flex items-center gap-1 text-[11px] tabular-nums">
          <span className="text-emerald-500 dark:text-emerald-400">
            +{file.additions}
          </span>
          <span className="text-rose-500 dark:text-rose-400">
            −{file.deletions}
          </span>
        </span>
      )}
    </div>
  )
}

function statusLabel(code: string): {
  glyph: string
  title: string
  className: string
} {
  const c = code.trim()
  if (code === "??")
    return {
      glyph: "U",
      title: "Untracked",
      className: "text-emerald-500 dark:text-emerald-400",
    }
  if (c.startsWith("A"))
    return {
      glyph: "A",
      title: "Added",
      className: "text-emerald-500 dark:text-emerald-400",
    }
  if (c.startsWith("D") || code.endsWith("D"))
    return {
      glyph: "D",
      title: "Deleted",
      className: "text-rose-500 dark:text-rose-400",
    }
  if (c.startsWith("R"))
    return {
      glyph: "R",
      title: "Renamed",
      className: "text-sky-500 dark:text-sky-400",
    }
  if (c.startsWith("C"))
    return {
      glyph: "C",
      title: "Copied",
      className: "text-sky-500 dark:text-sky-400",
    }
  return {
    glyph: "M",
    title: "Modified",
    className: "text-amber-500 dark:text-amber-400",
  }
}
