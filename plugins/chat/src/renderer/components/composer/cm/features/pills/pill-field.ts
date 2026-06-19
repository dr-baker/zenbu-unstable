import {
  RangeSetBuilder,
  StateEffect,
  StateField,
  type EditorState,
} from "@codemirror/state"
import { Decoration, EditorView } from "@codemirror/view"
import type { DbClient } from "@zenbujs/core/react"
import { FilePillWidget, ImagePillWidget, UploadPillWidget } from "./pill-widget"
import { scanPills, selectionTouchesPill, type Pill } from "./pill-scan"

/**
 * Pill rendering is fully derived from `(doc, fileIndex, selection)`.
 * There is no per-pill state field — anywhere the doc contains a
 * recognised `@`-reference, a pill appears. Pasted text, undo/redo,
 * external edits all just work because there's no parallel state to
 * keep in sync.
 *
 * The one bit of state we DO keep is the file index, supplied by the
 * surrounding React tree via `setFileIndexEffect`. The index is what
 * lets us say "yes, `@src/foo.ts` is a real pill" vs. "no, `@made-up`
 * is plain text" without doing IO from inside the editor.
 */

/** Replace the editor's known file paths. Dispatch on mount and again
 * whenever the surrounding `files` prop changes. */
export const setFileIndexEffect = StateEffect.define<ReadonlySet<string>>()

/** Indexed file paths. Empty until the surrounding component fills it in. */
export const fileIndexField = StateField.define<ReadonlySet<string>>({
  create() {
    return new Set<string>()
  },
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setFileIndexEffect)) return e.value
    }
    return value
  },
  // Keep the field out of serialized state — it's externally owned.
})

/** Inject the db client used by image pill widgets to hydrate bytes
 * from the blob store on cache miss. Dispatched once at mount time
 * by `composer.tsx`. The widget tree can't call `useDbClient` itself
 * because it runs outside `<ZenbuProvider>` (mounted by CM via
 * `createRoot`). */
export const setDbClientEffect = StateEffect.define<DbClient | null>()

export const dbClientField = StateField.define<DbClient | null>({
  create() {
    return null
  },
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setDbClientEffect)) return e.value
    }
    return value
  },
})

/** Compute pills for the current state. Exposed so the serializer in
 * `composer.tsx` can lower the editor state into wire form without
 * re-implementing the scan. */
export function getPills(state: EditorState): Pill[] {
  return scanPills(state.doc.toString(), state.field(fileIndexField))
}

export const pillDecorations = EditorView.decorations.compute(
  [fileIndexField, dbClientField, "doc", "selection"],
  state => {
    const sel = state.selection.main
    const client = state.field(dbClientField)
    const pills = scanPills(state.doc.toString(), state.field(fileIndexField))
    const builder = new RangeSetBuilder<Decoration>()
    for (const p of pills) {
      // Live-preview: cursor touching a pill exposes the raw text.
      if (selectionTouchesPill(sel, p)) continue
      const widget =
        p.kind === "file"
          ? new FilePillWidget(p.filePath, p.fileName)
          : p.kind === "upload"
            ? new UploadPillWidget(p.filePath, p.fileName)
            : new ImagePillWidget(p.blobId, p.mimeType, client)
      builder.add(p.from, p.to, Decoration.replace({ widget, inclusive: false }))
    }
    return builder.finish()
  },
)

export const pillAtomicRanges = EditorView.atomicRanges.of(view => {
  const state = view.state
  const sel = state.selection.main
  const pills = scanPills(state.doc.toString(), state.field(fileIndexField))
  const builder = new RangeSetBuilder<Decoration>()
  for (const p of pills) {
    if (selectionTouchesPill(sel, p)) continue
    builder.add(p.from, p.to, Decoration.mark({}))
  }
  return builder.finish()
})

export type { Pill }
