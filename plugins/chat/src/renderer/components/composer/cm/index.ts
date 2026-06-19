/**
 * Integration point for every CodeMirror feature the composer uses.
 *
 * Each subfolder under `features/` is a self-contained CodeMirror
 * extension (or small handle wrapping one). The composer composes
 * them at mount time — there is no implicit ordering or hidden
 * coupling between features, and any feature can be lifted out into
 * its own plugin later without dragging the others along.
 *
 * Re-exports are kept narrow on purpose — only the surface that the
 * React layer (composer.tsx, the wire serializer, the typeahead
 * popups) actually consumes. Anything internal to a feature stays
 * inside its folder.
 */

export { pillsFeature } from "./features/pills"
export type { Pill } from "./features/pills"
export {
  formatBlobMarker,
  getPills,
  setDbClientEffect,
  setFileIndexEffect,
} from "./features/pills"

export { detectTrigger } from "./features/typeahead"
export type { TriggerKind, TriggerMatch } from "./features/typeahead"

export { composerThemeFeature } from "./features/theme"
