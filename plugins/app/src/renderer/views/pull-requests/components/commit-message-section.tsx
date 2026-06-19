import { useCallback, useState } from "react"
import { useRpc } from "@zenbujs/core/react"
import { Button } from "@zenbu/ui/button"
import { Input } from "@zenbu/ui/input"
import { Spinner } from "@zenbu/ui/spinner"
import { MarkdownEditor } from "@/components/common/markdown-editor"
import { ErrorBanner } from "./error-banner"

/**
 * Inline "stage + commit everything" composer. Only mounts when
 * `CreatePrPane` detects a dirty working tree.
 *
 * The component is deliberately opinionated: it always stages every
 * change (`git add -A`) and commits as a single commit, because the
 * PR flow needs the working tree clean before we can compute "what
 * commits would this PR contain". Users who want granular staging
 * should use the dedicated Git view.
 *
 * "Generate with AI" calls into `github.generateCommitMessage` which
 * uses the shared small-model resolver, so we inherit auth discovery
 * from there.
 */
export function CommitMessageSection({
  directory,
  onCommitted,
  autoFocus = false,
}: {
  directory: string
  onCommitted: () => void
  /** When true (the dirty-tree phase of the PR composer), the
   *  subject input mounts focused so the user can start typing
   *  immediately. The chat composer follows the same convention. */
  autoFocus?: boolean
}) {
  const rpc = useRpc()
  const [subject, setSubject] = useState("")
  const [body, setBody] = useState("")
  const [generating, setGenerating] = useState(false)
  const [committing, setCommitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleGenerate = useCallback(async () => {
    setGenerating(true)
    setError(null)
    try {
      const res = await rpc.app.github.generateCommitMessage({ directory })
      if (res.ok) {
        setSubject(res.subject)
        setBody(res.body)
      } else {
        setError(res.error)
      }
    } finally {
      setGenerating(false)
    }
  }, [directory, rpc])

  const handleCommit = useCallback(async () => {
    if (!subject.trim()) {
      setError("Commit message is required")
      return
    }
    setCommitting(true)
    setError(null)
    try {
      const res = await rpc.app.github.commit({
        directory,
        subject: subject.trim(),
        body: body.trim() || undefined,
      })
      if (res.ok) {
        setSubject("")
        setBody("")
        onCommitted()
      } else {
        setError(res.error)
      }
    } finally {
      setCommitting(false)
    }
  }, [body, directory, onCommitted, rpc, subject])

  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-[15px] font-medium">
        Commit your changes to start the PR
      </h2>

      <div className="flex flex-col gap-2">
        <Input
          value={subject}
          onChange={e => setSubject(e.target.value)}
          placeholder="Commit message"
          className="h-9 text-[14px]"
          autoFocus={autoFocus}
          onKeyDown={e => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              void handleCommit()
            }
          }}
        />
        <MarkdownEditor
          value={body}
          onChange={setBody}
          placeholder="Extended description (optional)"
          className="min-h-[100px] resize-y"
        />
        {error && (
          <ErrorBanner
            title="Commit failed"
            detail={error}
            onDismiss={() => setError(null)}
          />
        )}
        <div className="flex items-center justify-between gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void handleGenerate()}
            disabled={generating}
            className="h-6 px-2 text-[11px] text-muted-foreground"
          >
            {generating ? (
              <>
                <Spinner size={12} /> Generating
              </>
            ) : (
              "Generate with AI"
            )}
          </Button>
          <Button
            type="button"
            onClick={() => void handleCommit()}
            disabled={committing || !subject.trim()}
            size="sm"
            className="h-7 px-3 text-[12px]"
          >
            {committing ? "Committing…" : "Commit"}
          </Button>
        </div>
      </div>
    </div>
  )
}
