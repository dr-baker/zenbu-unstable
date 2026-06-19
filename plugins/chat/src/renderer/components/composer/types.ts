export type FileEntry = { path: string; name: string }

export type FileEntryProvider = {
  /** Changes when the backing path collection changes. */
  version: string
  /** Search lazily for typeahead results without materializing every entry. */
  search: (query: string, limit: number) => FileEntry[]
  /** Build/return the full path set only when pill validation needs it. */
  getPathSet: () => ReadonlySet<string>
}

export type ComposerIntent = "default" | "steer" | "followUp"

export type SlashCommand = {
  id: string
  label: string
  description?: string
  /** Optional group header in the typeahead menu. */
  group?: string
  /** Short provenance/status text rendered on the right side. */
  hint?: string
  /** When set, picking this command fires `onAction(action)` and clears the input. */
  action?: string
  /** When set, picking this command replaces the trigger with this text. */
  insertText?: string
  /** Slash text to use when Tab completes this menu item without activating it. */
  completionText?: string
  /** When set, picking this command strips the slash trigger from
   * the doc and immediately submits whatever's left with the given
   * intent. Used for the `/queue` and `/steer` commands — the user
   * never sees a sticky mode chip; the command itself sends. */
  submitWith?: Exclude<ComposerIntent, "default">
}
