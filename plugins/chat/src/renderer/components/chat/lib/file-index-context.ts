import { createContext } from "react"
import type { FileEntry } from "../../composer/types"

/**
 * Surfaces the chat's known file index to descendant message
 * components. Read by `UserMessage` so the read-only composer can
 * decorate `@<filePath>` tokens as file pills.
 *
 * Empty array is the "no scope / no files yet" default — image pills
 * still render (their detection doesn't depend on the file index),
 * file references fall through to plain text.
 */
export const FileIndexContext = createContext<FileEntry[]>([])
