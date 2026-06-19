import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { nanoid } from "nanoid"
import type { ReposApi, SessionsService } from "../sessions"

const execFileP = promisify(execFile)

type Svc = SessionsService

/**
 * Move a chat (and its underlying session, if any) into a freshly
 * created git worktree of the same repo.
 *
 *   1. Create the worktree on disk (`git worktree add -b <branch> <path>`)
 *      via `ReposService.createWorktree`, which also re-syncs the
 *      repo's worktree list into the DB.
 *   2. If the chat has a live `AgentSession` that's mid-turn, abort
 *      it and wait for the interrupt to land. Then dispose the live
 *      session entirely so the next prompt re-activates against the
 *      new cwd.
 *   3. In one DB transaction:
 *        - Materialize a new `scope` pointing at the new worktree
 *          directory (same workspace + repo).
 *        - Flip `chat.scopeId` and (when present) `session.scopeId`
 *          to the new scope.
 *        - Update the window's `selectedScopeId` cache when the
 *          moved chat is the active tab.
 *
 * The pi session JSONL on disk is untouched — it lives in
 * `PI_SESSION_DIR`, not the working directory — so the conversation
 * history is preserved. Only the cwd that pi's tools execute against
 * changes, and that happens lazily on the next `ensureLive()`.
 *
 * Errors:
 *   - chat unknown / no scope / scope has no `repoId` → throws.
 *   - `git worktree add` fails → throws with the git error.
 */
export async function moveToNewWorktree(args: {
  svc: Svc
  chatId: string
  /** New branch name. Passed straight to `git worktree add -b`. */
  branch: string
  /** Absolute path for the new worktree. */
  worktreePath: string
  /** Active window id; used to keep `selectedScopeId` in sync when
   * this chat is currently the active tab. */
  windowId: string
  /**
   * Optional: if the *source* worktree has uncommitted changes,
   * commit them before creating the new worktree so the new
   * worktree branches off the post-commit HEAD (carrying the
   * work forward). When omitted the pending changes stay in the
   * source worktree as working-tree state and the new worktree
   * starts from the current HEAD without them. Empty `message`
   * → auto-generated marker.
   */
  commitFirst?: { message: string }
}): Promise<{ scopeId: string; directory: string }> {
  const { svc } = args
  const branch = args.branch.trim()
  const worktreePath = args.worktreePath.trim()
  if (!branch) throw new Error("branch name is required")
  if (!worktreePath) throw new Error("worktree path is required")

  const root0 = svc.ctx.db.client.readRoot()
  const chat = root0.app.chats[args.chatId]
  if (!chat) throw new Error(`unknown chat ${args.chatId}`)
  const oldScope = root0.app.scopes[chat.scopeId]
  if (!oldScope) throw new Error(`unknown scope ${chat.scopeId}`)
  if (!oldScope.repoId) {
    throw new Error("current scope is not a git repo (no repoId on scope)")
  }

  // 0. Optional: commit uncommitted changes in the *current*
  //    worktree before branching, so the new worktree picks them
  //    up. This answers "do I want to take my pending changes
  //    with me?". When `commitFirst` is omitted the pending
  //    changes stay in the source worktree's working directory
  //    (the original behavior).
  if (args.commitFirst) {
    const message =
      args.commitFirst.message.trim() ||
      `auto-generated commit (worktree branch \`${branch}\`)`
    try {
      await execFileP("git", ["-C", oldScope.directory, "add", "-A"])
      await execFileP("git", [
        "-C",
        oldScope.directory,
        "commit",
        "-m",
        message,
      ])
    } catch (err) {
      // "nothing to commit" can happen if the renderer detected
      // dirty state that was tidied between then and now — not
      // really an error, just a no-op.
      const e = err as { stderr?: string; stdout?: string; message?: string }
      const detail = (e.stderr ?? e.stdout ?? e.message ?? "").toString()
      if (!/nothing to commit/i.test(detail)) {
        throw new Error(detail || "pre-worktree commit failed")
      }
    }
  }

  // 1. Create the worktree on disk. ReposService handles
  //    re-syncing the repo's worktree list into the DB.
  const createRes = await (svc.ctx.repos as ReposApi).createWorktree({
    repoId: oldScope.repoId,
    worktreePath,
    branch,
    // No sourceRef → git defaults to current HEAD of the probe
    // worktree, which is what users expect ("branch off where I am").
    createBranch: true,
  })
  if (!createRes.ok) {
    throw new Error(createRes.error ?? "git worktree add failed")
  }

  // 2. If the chat has a ready session, interrupt + dispose any
  //    live AgentSession so the next prompt re-activates with the
  //    new cwd. (Pi's tools capture cwd in closures at construction
  //    time — there's no in-place cwd swap.)
  const sessionId =
    chat.session.kind === "ready" ? chat.session.sessionId : null
  if (sessionId) {
    const live = svc.live.get(sessionId)
    if (live) {
      if (live.pi.isStreaming) {
        // Await the interrupt before tearing down so we don't drop
        // tool output mid-stream and leave pi in a weird state.
        await live.pi.abort()
      }
      live.dispose()
      svc.live.delete(sessionId)
    }
  }

  // 3. Single transactional flip: new scope + repoint chat + repoint
  //    session + window's selectedScopeId cache. Treats the move as
  //    a copy-and-rm (per design): old scope is left intact so any
  //    other chats living in it (or the sidebar's group heuristic)
  //    keep working. Sidebar already hides empty scope groups.
  const newScopeId = nanoid()
  const now = Date.now()
  await svc.ctx.db.client.update(root => {
    // "Move chat to new worktree" creates a secondary scope by
    // construction — the user is forking off from an existing
    // one. Always start unpinned; the main worktree's pin is
    // already established on the original scope.
    root.app.scopes[newScopeId] = {
      id: newScopeId,
      workspaceId: oldScope.workspaceId,
      directory: worktreePath,
      repoId: oldScope.repoId,
      extraDirectories: [],
      createdAt: now,
      archived: false,
      archivedAt: null,
      pinnedAt: null,
      unpinnedAt: null,
      pluginName: null,
    }
    const c = root.app.chats[args.chatId]
    if (c) c.scopeId = newScopeId
    if (sessionId) {
      const s = root.pi.sessions[sessionId]
      if (s) s.scopeId = newScopeId
    }
    // If the moved chat was the active tab, follow it: switch
    // the active scope to the new one so the user sees the new
    // worktree. The new scope's pane state is materialized
    // lazily by the renderer on first paint via
    // `ensureScopePanes`, seeded with this chat.
    const ws = root.app.windowStates[args.windowId]
    if (ws && ws.activeView.kind === "workspace") {
      const sourceScopeId = ws.selectedScopeId
      const state = sourceScopeId ? ws.scopePanes?.[sourceScopeId] : null
      const activePane = state?.panes.find(p => p.id === state.activePaneId)
      const activeTab = activePane?.tabs.find(
        t => t.id === activePane.activeTabId,
      )
      if (
        activeTab &&
        activeTab.content.kind === "chat" &&
        activeTab.content.chatId === args.chatId
      ) {
        ws.selectedScopeId = newScopeId
        ws.workspaceActiveScope[ws.activeView.workspaceId] = newScopeId
      }
    }
  })

  return { scopeId: newScopeId, directory: worktreePath }
}

/**
 * Move a chat (and its underlying session, if any) into an
 * EXISTING scope. Sister to `moveToNewWorktree`, but for the
 * case where the destination scope already exists — e.g. the
 * worktree-handoff flow's "move this chat back to the main
 * worktree once you're done" step.
 *
 * Same shape as `moveToNewWorktree`'s post-creation flip:
 *   1. Interrupt + dispose any live AgentSession so its cwd
 *      gets re-resolved against the new scope on next prompt.
 *   2. In one DB transaction:
 *        - chat.scopeId ← new
 *        - session.scopeId ← new (if any)
 *        - (optionally) chat.createdAt ← now, so it bubbles to
 *          the top of the sidebar's chat list. This is what the
 *          handoff panel wants — "this chat just landed work,
 *          surface it".
 *        - Window's `selectedScopeId` cache flips when this is
 *          the active tab.
 */
export async function moveChatToExistingScope(args: {
  svc: Svc
  chatId: string
  newScopeId: string
  windowId: string
  bumpCreatedAt: boolean
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const { svc } = args
  const root0 = svc.ctx.db.client.readRoot()
  const chat = root0.app.chats[args.chatId]
  if (!chat) {
    return { ok: false, error: `unknown chat ${args.chatId}` }
  }
  const newScope = root0.app.scopes[args.newScopeId]
  if (!newScope) {
    return { ok: false, error: `unknown scope ${args.newScopeId}` }
  }
  if (chat.scopeId === args.newScopeId) {
    return { ok: true } // already there
  }

  const sourceScopeId = chat.scopeId
  const sessionId =
    chat.session.kind === "ready" ? chat.session.sessionId : null
  if (sessionId) {
    const live = svc.live.get(sessionId)
    if (live) {
      if (live.pi.isStreaming) {
        await live.pi.abort()
      }
      live.dispose()
      svc.live.delete(sessionId)
    }
  }

  const now = Date.now()
  await svc.ctx.db.client.update(root => {
    const c = root.app.chats[args.chatId]
    if (c) {
      c.scopeId = args.newScopeId
      if (args.bumpCreatedAt) c.createdAt = now
    }
    if (sessionId) {
      const s = root.pi.sessions[sessionId]
      if (s) s.scopeId = args.newScopeId
    }
    const ws = root.app.windowStates[args.windowId]
    if (ws && ws.activeView.kind === "workspace") {
      // Same shape as `moveToNewWorktree`'s active-tab follow:
      // look in the *source* scope's panes (where the chat lived
      // before this transaction) to see if it was the active tab.
      // The original code reached for `ws.workspacePanes[...]`,
      // which doesn't exist on the schema — silent no-op.
      const state = ws.scopePanes?.[sourceScopeId]
      const activePane = state?.panes.find(p => p.id === state.activePaneId)
      const activeTab = activePane?.tabs.find(
        t => t.id === activePane.activeTabId,
      )
      if (
        activeTab &&
        activeTab.content.kind === "chat" &&
        activeTab.content.chatId === args.chatId
      ) {
        ws.selectedScopeId = args.newScopeId
        ws.workspaceActiveScope[ws.activeView.workspaceId] = args.newScopeId
      }
    }
  })

  return { ok: true }
}
