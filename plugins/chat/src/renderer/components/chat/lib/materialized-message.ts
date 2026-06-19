export type ToolCallContentItem =
  | { type: "text"; text: string }
  | { type: "diff"; path: string; oldText?: string; newText: string }

export type PlanEntry = {
  content: string
  status: string
  priority?: "high" | "medium" | "low"
}

export type PermissionOption = {
  optionId: string
  name: string
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always"
}

type WithKey = { key?: string }

export type ToolResponse = {
  stdout?: string
  stderr?: string
}

export type ToolMessage = WithKey & {
  role: "tool"
  toolCallId: string
  title: string
  subtitle?: string
  kind: string
  status: "pending" | "running" | "completed" | "failed" | "interrupted"
  contentItems?: ToolCallContentItem[]
  toolName?: string
  rawInput?: unknown
  rawOutput?: unknown
  toolResponse?: ToolResponse | null
  /** False while pi is still streaming / parsing the tool-call JSON
   * arguments. Once the assistant message closes (or tool execution
   * starts), the args are complete and UI that depends on exact
   * paths can switch from provisional affordances to real labels. */
  argsComplete?: boolean
  /** For `edit` / `write` tool calls: the worktree-relative path of
   * the file the tool is operating on (or the absolute path if the
   * file lives outside every tracked worktree). Computed in
   * `materialize.ts` from the tool args so the card doesn't have to
   * re-inspect `rawInput`. Null for non-edit tools and for early
   * streaming frames where the `path` field hasn't arrived yet. */
  editPath?: string | null
  /** For `edit` / `write` tool calls: the worktree directory the
   * edited / created file lives in. Resolved by longest-prefix
   * match against the chat's primary `directory` plus every entry
   * in `extraDirectories`. The chat-pane uses this as the
   * `directory` arg to `rpc.app.gitTree.openDiff` so the diff opens
   * against the right git repo even when the file is in an extra
   * dir. Null when no path is known yet or the chat has no scope. */
  editDirectory?: string | null
}

export type UserImageRef = { blobId: string; mimeType: string }

export type MaterializedMessage =
  | (WithKey & {
      role: "user"
      content: string
      /** Inline image references (chat-history side; bytes hydrated
       * lazily via the renderer image cache). */
      images?: UserImageRef[]
      timeSent?: number
      editorState?: unknown
      /** 0-based index of this user message among user messages on
       * the current session path. Used by the inline edit-to-fork
       * flow to resolve the corresponding pi entry id at fork time
       * (chat-pane keeps a list of user entry ids on the current
       * path; index lookup is O(1)). */
      userMessageIndex?: number
    })
  | (WithKey & { role: "assistant"; content: string })
  | (WithKey & { role: "thinking"; content: string; streaming?: boolean })
  | ToolMessage
  | (WithKey & { role: "plan"; entries: PlanEntry[] })
  | (WithKey & {
      role: "permission_request"
      requestId: string
      title: string
      description?: string
      options: PermissionOption[]
      responded?: boolean
    })
  | (WithKey & {
      role: "turn_summary"
      /** Files modified during this turn (between the previous
       * `user_prompt` and the closing `agent_end`). Ordered by
       * first-edit time. `editCount` counts every successful
       * `edit` / `write` tool execution against that path; `op`
       * is the first observed operation — `create` if the file
       * was first touched with `write`, `edit` if it was first
       * touched with `edit` (a subsequent edit on a file we
       * created still reads as "created" because the create is
       * the dominant user-facing action). */
      files: {
        path: string
        /** Worktree directory the file lives in. Usually the scope's
         * primary `directory`, but can be one of the scope's
         * `extraDirectories` when the edit landed in an extra dir.
         * Forwarded as the `directory` arg to
         * `rpc.app.gitTree.openDiff(...)` so the diff opens against
         * the right git repo — each extra dir is its own worktree
         * and `pr.getStatus` is scoped per directory. Null only
         * when materialize was called without any directory at all. */
        directory: string | null
        editCount: number
        op: "create" | "edit"
        /** Lines added across every successful op for this path.
         * For `create` the count is the size of the written file
         * (every line is new); for `edit` it's the unique-by-line
         * additions across all diffs, matching the inline edit
         * tool card's `+N` badge. */
        additions: number
        /** Lines removed across every successful op for this path.
         * Always 0 for `create` (nothing existed yet). */
        removals: number
      }[]
      /** Worktree directory the edits happened in, used as the
       * `directory` arg when opening the matching `git-diff` view.
       * Null when materialize was called without a scope (renderer
       * still has no live session) — the renderer hides the card
       * in that case. */
      directory: string | null
      /** Workspace the chat owning this card lives in. Threaded
       * through to `rpc.app.gitTree.openDiff` so the shell opens
       * the diff in *this* workspace's pane state, not the
       * window's currently-active workspace (which can drift if
       * the user clicked into another workspace and the chat is
       * still visible via a popout window or the agents palette). */
      workspaceId: string | null
      /** Scope (worktree) the chat owning this card lives in. The
       * `openDiff` handler pins `selectedScopeId` to this value
       * after splitting the diff pane, so the sidebar / commit
       * button stay anchored to the right worktree instead of
       * falling back to the workspace's primary scope (which is
       * what happens when the active tab has no `chatId`). */
      scopeId: string | null
    })
  | (WithKey & { role: "interrupted" })
  | (WithKey & {
      /** Emitted on `message_end` with `stopReason` error/aborted.
       * `detail` is the parsed provider message when available. */
      role: "error"
      message: string
      detail?: string | null
      stopReason?: string
    })
  | (WithKey & {
      /** Divider rendered in place of the sentinel-wrapped user
       * message `SessionsService.continueKilled` dispatches after
       * a hot-reload auto-resume. Looks like "— Agent reloaded —".
       * The wrapped text the model received is intentionally hidden
       * so the chat reads as one continuous turn. */
      role: "system_reload"
      /** Wall-clock of the resume, for tooltips/sorting. Not
       * currently rendered. */
      timestamp: number
    })
  | (WithKey & {
      role: "clone_marker"
      /** Whether the new session was produced by `/clone` (history
       * preserved verbatim) or `/fork` (history truncated at a user
       * message which moved into the composer). Drives the marker
       * label so users can tell the two apart. */
      variant: "clone" | "fork"
      parentSessionId: string | null
      parentTitle: string | null
      parentEntryId: string | null
      /** Wall-clock timestamp the clone/fork was performed. */
      timestamp: number
    })
