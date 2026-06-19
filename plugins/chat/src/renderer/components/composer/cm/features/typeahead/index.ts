/**
 * Typeahead feature — `@` / `/` trigger detection.
 *
 * Unlike the other features in this folder, the typeahead doesn't
 * register a CodeMirror extension. The popup that renders results
 * lives in React (FilePickerMenu / SlashCommandMenu) and the
 * composer drives it from an `EditorView.updateListener`. All this
 * module owns is the pure trigger-detection helper, exposed below.
 *
 * Kept as a "feature" folder anyway so adding more triggers, or a
 * fancier matcher, stays a single self-contained edit.
 */

export { detectTrigger } from "./typeahead"
export type { TriggerKind, TriggerMatch } from "./typeahead"
