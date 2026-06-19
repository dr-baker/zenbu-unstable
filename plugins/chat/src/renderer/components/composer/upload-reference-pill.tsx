import { PaperclipIcon } from "lucide-react"

export type UploadReferencePillProps = {
  fileName: string
  filePath: string
}

/**
 * Inline chip rendered over an `@upload:<absPath>` token in the
 * composer doc. Visually distinct from the file-pill chip (different
 * accent, paperclip icon) so the user can tell at a glance which
 * references are workspace files vs. uploaded blobs from elsewhere on
 * disk.
 */
export function UploadReferencePill({
  fileName,
  filePath,
}: UploadReferencePillProps) {
  return (
    <span
      className="inline-flex max-w-[240px] items-center gap-1 rounded border border-emerald-400/20 bg-emerald-500/10 px-1 py-px align-bottom text-[11px] font-medium text-emerald-700 dark:text-emerald-300"
      aria-label={`upload: ${filePath}`}
      title={filePath}
    >
      <PaperclipIcon className="h-3 w-3 shrink-0" />
      <span className="truncate">{fileName}</span>
    </span>
  )
}
