import { FileIcon } from "@/components/common/file-icon"

export type FileReferencePillProps = {
  fileName: string
  filePath: string
}

export function FileReferencePill({ fileName, filePath }: FileReferencePillProps) {
  return (
    <span
      className="inline-flex max-w-[240px] items-center gap-1 rounded border border-blue-400/20 bg-blue-500/10 px-1 py-px align-bottom text-[11px] font-medium text-blue-600 dark:text-blue-300"
      aria-label={filePath}
    >
      <FileIcon path={filePath} size={12} className="shrink-0" />
      <span className="truncate">{fileName}</span>
    </span>
  )
}
