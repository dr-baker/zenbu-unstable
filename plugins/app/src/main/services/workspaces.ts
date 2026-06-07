import path from "node:path"
import { nanoid } from "nanoid"
import { Service } from "@zenbujs/core/runtime"
import { DbService, WindowService } from "@zenbujs/core/services"
import { skeletonRouteForActiveView } from "../../shared/boot-skeleton"
import { buildContextMenuPrepend } from "../lib/context-menu-prepend"
import { ReposService } from "./repos"
import { SessionsService } from "./sessions"
import { WorkspaceIconService } from "./workspace-icon"
import type { Schema } from "../schema"

type WindowState = Schema["windowStates"][string]
type ScopePaneState = WindowState["scopePanes"][string]

/**
 * Owns the "create a workspace from a directory" flow.
 *
 * Lives main-side specifically because creating a workspace is a
 * compound operation:
 *
 *   1. `repos.detectAndSync(directory)` to (idempotently) materialize
 *      the git repo row.
 *   2. Write the workspace + scope + chat + per-window pane state to
 *      the DB.
 *   3. `sessions.createChatSession(...)` to flip the chat from
 *      `pending` to `ready`.
 *
 * Step 3 reads the scope and chat written in step 2. If step 2 ran
 * in the renderer (as it used to), the renderer's `client.update`
 * resolves once the *central* cache has the write — but main's
 * local replica receives the write via a `replicated-write`
 * broadcast which is dispatched *after* the ack is sent. There's a
 * real window where `root.app.scopes[scopeId]` is undefined on
 * main even though the renderer "saw" its own update. Polling that
 * window away is masking a layering bug; doing all writes on the
 * same side as the subsequent read is the deterministic fix.
 *
 * Pulling steps 2 and 3 into a single main-side service method
 * collapses the race: main's `db.client` is in-process with the
 * server, so writes hit the central cache directly and are
 * immediately visible to the next `readRoot()` on the same side.
 * The renderer just awaits the RPC; UI updates flow back via the
 * normal sync broadcast.
 */
export class WorkspacesService extends Service.create({
  key: "workspaces",
  deps: {
    db: DbService,
    repos: ReposService,
    sessions: SessionsService,
    workspaceIcon: WorkspaceIconService,
    window: WindowService,
  },
}) {
  /** Spawn a new window focused on `workspaceId`, landing on its
   * last-active scope (or first non-archived scope). */
  async openInNewWindow(args: {
    workspaceId: string
  }): Promise<{ windowId: string }> {
    const root = this.ctx.db.client.readRoot()
    const ws = root.app.workspaces[args.workspaceId]
    if (!ws) {
      throw new Error(`workspace ${args.workspaceId} not found`)
    }

    let selectedScopeId: string | null = null
    for (const w of Object.values(root.app.windowStates)) {
      const candidate = w.workspaceActiveScope[args.workspaceId]
      if (candidate && root.app.scopes[candidate]) {
        selectedScopeId = candidate
        break
      }
    }
    if (!selectedScopeId) {
      const firstScope = Object.values(root.app.scopes).find(
        s => s.workspaceId === args.workspaceId && !s.archived,
      )
      selectedScopeId = firstScope?.id ?? null
    }

    const newWindowId = nanoid()
    const activeView = {
      kind: "workspace" as const,
      workspaceId: args.workspaceId,
    }

    await this.ctx.db.client.update(r => {
      r.app.windowStates[newWindowId] = {
        selectedScopeId,
        scopeLastTerminal: {},
        activeView,
        scopePanes: {},
        workspaceActiveScope: selectedScopeId
          ? { [args.workspaceId]: selectedScopeId }
          : {},
        // Rail on by default; the user toggles via ⌘⇧B.
        workspaceRailOpen: true,
        workspaceUiStates: {},
        scopeUiStates: {},
        pluginsView: { selectedPluginName: null, sidebarOpen: true },
        fullscreen: false,
      }
    })

    return this.ctx.window.openWindow({
      windowId: newWindowId,
      query: { skeletonRoute: skeletonRouteForActiveView(activeView) },
      baseWindow: {
        minWidth: 430,
        minHeight: 310,
        trafficLightPosition: { x: 14, y: 12 },
      },
      contextMenu: { prepend: buildContextMenuPrepend() },
    })
  }

  /**
   * Create a workspace anchored at `directory`, focus it in
   * `windowId`, and return ids for the renderer to reference.
   *
   * `windowId` is the calling window. We need it so the new
   * workspace becomes the active view *in that window* (without
   * disturbing other open windows). It comes from the renderer's
   * `useWindowId()` and is opaque to us.
   *
   * Throws on detect/sync failure — the onboarding screen already
   * wraps callers in `try { ... } catch(err) { setError(...) }`,
   * so a propagated error surfaces inline instead of leaving the
   * user with a half-built workspace.
   */
  async createFromDirectory(args: {
    directory: string
    windowId: string
  }): Promise<{
    workspaceId: string
    scopeId: string
    chatId: string | null
    sessionId: string | null
  }> {
    const { repoId } = await this.ctx.repos.detectAndSync({
      directory: args.directory,
    })

    // Dedupe by directory. If a non-archived scope at this exact
    // path already exists in a non-archived, rail-visible
    // workspace, just focus it instead of creating a duplicate
    // workspace+scope pair at the same path. Handles the
    // "Open recent" / manual folder picker collision where the
    // user picks a directory they already have a workspace for.
    //
    // We deliberately look at scopes (not workspaces) because the
    // scope's `directory` is the source of truth for "this
    // workspace lives here". If the matching scope is in an
    // archived workspace — or in a `kind: "plugin"` workspace,
    // which is filtered out of the workspace rail and reached
    // through the plugins sidebar instead — we fall through and
    // let the normal create path run. Otherwise the onboarding
    // screen would silently focus a workspace the user can't
    // see, which looks like "my click did nothing".
    const existing = this.findExistingScopeFor(args.directory)
    if (existing) {
      await this.ctx.db.client.update(root => {
        const ws = ensureWindowState(root, args.windowId)
        ws.activeView = { kind: "workspace", workspaceId: existing.workspaceId }
        ws.selectedScopeId = existing.scopeId
        ws.workspaceActiveScope[existing.workspaceId] = existing.scopeId
      })
      return {
        workspaceId: existing.workspaceId,
        scopeId: existing.scopeId,
        // No chat created on the dedupe path — we're just
        // selecting an existing workspace. Callers already treat
        // these as optional (they're only used by the renderer's
        // post-create focus dance, which is fine to skip here).
        chatId: null,
        sessionId: null,
      }
    }

    const workspaceId = nanoid()
    const scopeId = nanoid()
    const chatId = nanoid()
    const paneId = nanoid()
    const tabId = nanoid()
    const now = Date.now()
    const name = path.basename(args.directory) || "Workspace"

    await this.ctx.db.client.update(root => {
      // Workspace + scope + chat. Mirrors the literal shape the
      // renderer hook used to write so existing observers
      // (sidebar, workspace rail, chat-pane-container) keep
      // working unchanged. The first scope of a brand-new
      // workspace is always the anchor — we pin it at `now` so
      // the sidebar has a stable top row.
      root.app.workspaces[workspaceId] = {
        id: workspaceId,
        name,
        createdAt: now,
        icon: null,
        iconAuto: null,
        iconAutoAttempted: false,
        archived: false,
        kind: "default",
        defaultWorktreeBranch: null,
        playground: false,
      }
      root.app.scopes[scopeId] = {
        id: scopeId,
        workspaceId,
        directory: args.directory,
        repoId,
        extraDirectories: [],
        createdAt: now,
        archived: false,
        archivedAt: null,
        pinnedAt: now,
        unpinnedAt: null,
        pluginName: null,
      }
      root.app.chats[chatId] = {
        id: chatId,
        scopeId,
        session: { kind: "pending" },
        createdAt: now,
      }

      // Window pointer — switch this window onto the new
      // workspace + scope and seed a one-pane / one-tab layout
      // with the new chat focused. Pane state is keyed by scope
      // now (see schema's `scopePanes`), and the workspace's
      // last-active scope is stamped so reopening the workspace
      // lands here again.
      const ws = ensureWindowState(root, args.windowId)
      ws.activeView = { kind: "workspace", workspaceId }
      ws.selectedScopeId = scopeId
      ws.workspaceActiveScope[workspaceId] = scopeId
      const initialContent = { kind: "chat" as const, chatId }
      const paneState: ScopePaneState = {
        panes: [
          {
            id: paneId,
            tabs: [
              {
                id: tabId,
                content: initialContent,
              },
            ],
            activeTabId: tabId,
          },
        ],
        activePaneId: paneId,
      }
      ws.scopePanes[scopeId] = paneState
    })

    // Same process, same replica. `createChatSession` will read
    // the scope and chat we just wrote without going through any
    // sync boundary.
    const { sessionId } = await this.ctx.sessions.createChatSession({
      scopeId,
      chatId,
    })

    // Fire-and-forget icon discovery. We deliberately don't
    // await this: workspace creation should never wait on a
    // filesystem walk. The service has its own time budget and
    // swallows errors internally; the worst-case outcome is the
    // sidebar paints the letter-tile fallback until the user
    // opens the workspace again (and possibly forever, if the
    // repo genuinely has no favicon-like file).
    void this.ctx.workspaceIcon
      .discover({ workspaceId, directory: args.directory })
      .catch(err => {
        console.error("[workspaces] icon discover failed:", err)
      })

    return { workspaceId, scopeId, chatId, sessionId }
  }

  /**
   * Look for a non-archived scope at `directory` whose owning
   * workspace is also non-archived. Returns the matching ids, or
   * null when no live scope claims this path.
   *
   * The directory match is exact (string equality). We don't
   * canonicalize through `realpath` here — callers pass us the
   * same string they got from the OS file picker / recent-projects
   * cache, so in practice these line up. If we ever see false
   * negatives on symlinked checkouts we can layer `fs.realpath`
   * in.
   */
  private findExistingScopeFor(directory: string): {
    workspaceId: string
    scopeId: string
  } | null {
    const root = this.ctx.db.client.readRoot()
    for (const scope of Object.values(root.app.scopes)) {
      if (scope.directory !== directory) continue
      if (scope.archived) continue
      const ws = root.app.workspaces[scope.workspaceId]
      if (!ws || ws.archived) continue
      // Plugin-kind workspaces are filtered out of the workspace
      // rail (they're reached via the plugins sidebar), so they
      // aren't a valid dedupe target from the onboarding screen
      // — focusing one would hide the user's click.
      if (ws.kind === "plugin") continue
      return { workspaceId: ws.id, scopeId: scope.id }
    }
    return null
  }
}

/**
 * Local mirror of the renderer's `ensureWindowState`. Kept inline
 * so this service doesn't import `lib/window-state.ts` (a renderer
 * module that pulls in React). The two are intentionally
 * structurally identical — if you change one, update the other.
 */
function ensureWindowState(
  root: { app: { windowStates: Record<string, WindowState> } },
  windowId: string,
): WindowState {
  const existing = root.app.windowStates[windowId]
  if (existing) {
    if (!existing.scopeLastTerminal) existing.scopeLastTerminal = {}
    if (!existing.scopePanes) existing.scopePanes = {}
    if (!existing.workspaceActiveScope) existing.workspaceActiveScope = {}
    if (!existing.workspaceUiStates) existing.workspaceUiStates = {}
    if (!existing.scopeUiStates) existing.scopeUiStates = {}
    return existing
  }
  const fresh: WindowState = {
    selectedScopeId: null,
    scopeLastTerminal: {},
    activeView: { kind: "onboarding" },
    scopePanes: {},
    workspaceActiveScope: {},
    workspaceRailOpen: true,
    workspaceUiStates: {},
    scopeUiStates: {},
    pluginsView: { selectedPluginName: null, sidebarOpen: true },
    fullscreen: false,
  }
  root.app.windowStates[windowId] = fresh
  return fresh
}
