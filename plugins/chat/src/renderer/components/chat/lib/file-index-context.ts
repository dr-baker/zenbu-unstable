import { createContext } from "react"
import type { FileEntryProvider } from "../../composer/types"

/**
 * Surfaces the chat's known file index to descendant message
 * components. Read by `UserMessage` so the read-only composer can
 * decorate `@<filePath>` tokens as file pills.
 *
 * `null` is the "no scope / no files yet" default — image pills still
 * render (their detection doesn't depend on the file index), file
 * references fall through to plain text until a provider is available.
 */
export const FileIndexContext = createContext<FileEntryProvider | null>(null)
