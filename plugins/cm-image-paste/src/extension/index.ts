import type { Extension } from "@codemirror/state"
import { EditorView } from "@codemirror/view"
import { putImage } from "@zenbu/chat/image-cache"
import { getDbClient } from "../lib/db-client-ref"

/**
 * Paste-event interceptor. When the clipboard carries an image:
 *
 *   1. Read the bytes off the `File`.
 *   2. `createBlob(bytes)` to persist them in the zenbu blob store.
 *   3. `putImage(blobId, bytes, mimeType)` so the pill widget can
 *      render synchronously without waiting on hydration.
 *   4. Dispatch a transaction inserting `@blob:<id> ` at the live
 *      cursor (re-anchored, since the user may have moved during
 *      the async createBlob).
 *
 * The CodeMirror handler runs outside React, so it grabs the db
 * client from the plugin's module-level ref. The content script
 * keeps that ref up to date via `useDbClient()`.
 *
 * Returning `true` from the handler signals "I claimed this paste",
 * suppressing CM's default paste-as-text behavior.
 */

async function handleImagePaste(
  file: File,
  view: EditorView,
  insertPos: number,
): Promise<void> {
  const dbClient = getDbClient()
  if (!dbClient) {
    console.warn(
      "[cm-image-paste] no db client available; ignoring image paste",
    )
    return
  }
  const bytes = new Uint8Array(await file.arrayBuffer())
  const mimeType = file.type || "image/png"
  let blobId: string
  try {
    blobId = await dbClient.createBlob(bytes)
  } catch (err) {
    console.error("[cm-image-paste] createBlob failed:", err)
    return
  }
  putImage(blobId, bytes, mimeType)

  const text = `@blob:${blobId}`
  const head = Math.min(
    insertPos,
    view.state.doc.length,
    view.state.selection.main.head,
  )
  const pillTo = head + text.length
  view.dispatch({
    changes: { from: head, insert: `${text} ` },
    selection: { anchor: pillTo + 1 },
  })
}

const extension: Extension = EditorView.domEventHandlers({
  paste: (event, view) => {
    const items = event.clipboardData?.items
    if (!items) return false
    for (let i = 0; i < items.length; i++) {
      const item = items[i]!
      if (item.kind !== "file") continue
      if (!item.type.startsWith("image/")) continue
      const file = item.getAsFile()
      if (!file) continue
      event.preventDefault()
      const insertPos = view.state.selection.main.head
      void handleImagePaste(file, view, insertPos)
      return true
    }
    return false
  },
})

export default extension
