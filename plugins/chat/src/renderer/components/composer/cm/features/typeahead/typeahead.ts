import type { EditorState } from "@codemirror/state"

export type TriggerKind = "file" | "slash"

export type TriggerMatch = {
  kind: TriggerKind
  query: string
  /** Doc position of the trigger character (`@` or `/`). */
  from: number
  /** Doc position just past the query (cursor). */
  to: number
}

/**
 * Detect an active `@` or `/` typeahead trigger immediately before the cursor.
 * Returns null if the cursor is not on a valid trigger run.
 *
 * A trigger only activates when the character before it is start-of-line or
 * whitespace, matching the original Lexical typeahead behaviour.
 */
export function detectTrigger(state: EditorState): TriggerMatch | null {
  const sel = state.selection.main
  if (!sel.empty) return null
  const head = sel.head
  const line = state.doc.lineAt(head)
  const before = state.doc.sliceString(line.from, head)

  for (let i = before.length - 1; i >= 0; i--) {
    const ch = before[i]
    if (ch === "@" || ch === "/") {
      const prev = i === 0 ? "" : before[i - 1]
      if (prev !== "" && !/\s/.test(prev)) return null
      const query = before.slice(i + 1)
      if (/\s/.test(query)) return null
      return {
        kind: ch === "@" ? "file" : "slash",
        query,
        from: line.from + i,
        to: head,
      }
    }
    if (/\s/.test(ch)) return null
  }
  return null
}
