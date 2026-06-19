/**
 * Pills feature — file and image `@`-reference chips.
 *
 * The doc is the single source of truth: a `@<knownFilePath>` or a
 * `@blob:<id>` token in the document renders as a pill widget. There
 * is no per-pill state field; rendering is fully derived from
 * `(doc, fileIndex, dbClient, selection)` via `pillDecorations`.
 *
 * External wiring (re-exported for the composer's React layer):
 *   - `setFileIndexEffect` — push the latest set of known file paths.
 *   - `setDbClientEffect`  — hand the widget tree a db client so it
 *     can hydrate image bytes from the blob store on cache miss.
 *   - `getPills(state)`    — read the current pill list (used by the
 *     wire-serializer and the typeahead suppression check).
 */

import type { Extension } from "@codemirror/state"
import {
  dbClientField,
  fileIndexField,
  pillAtomicRanges,
  pillDecorations,
} from "./pill-field"

export function pillsFeature(): Extension {
  return [
    fileIndexField,
    dbClientField,
    pillDecorations,
    pillAtomicRanges,
  ]
}

export {
  getPills,
  setDbClientEffect,
  setFileIndexEffect,
} from "./pill-field"
export type { Pill } from "./pill-scan"
export { formatBlobMarker } from "./pill-scan"
