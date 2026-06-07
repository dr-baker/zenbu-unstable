import { useDb } from "@zenbujs/core/react"
import { resolveChatLabel } from "@/lib/chat-label"
import type { Schema } from "../../../main/schema"

type Chat = Schema["chats"][string]
type Scope = Schema["scopes"][string]
type Repo = Schema["repos"][string]

export type ChatTitleBarProps = {
  chat: Chat
  sessionId: string | null
  /** Whether the chat content below is currently scrollable. When
   * false, there's nothing to fade INTO — the bar's bottom edge
   * just meets empty pane background — so we suppress the gradient
   * overlay to avoid a phantom shadow on otherwise pristine chats. */
  hasOverflow: boolean
}

// Height (px) of the soft fade region that sits below the title bar
// and overlays the top of the chat content. Mirrors
// `SIDEBAR_FOOTER_FADE` so the chrome reads consistent across
// surfaces: messages dissolve under the bar the same way sidebar
// rows dissolve under the footer.
const CHAT_TITLE_FADE = 24

/**
 * Slim bar pinned to the top of the chat pane. Shows the chat's
 * resolved label (Pi session name → fallback) so the user can glance
 * at the pane and know which work they're
 * looking at. When there's a meaningful scope label (worktree branch
 * / directory basename) and it differs from the chat label, it's
 * surfaced as a muted prefix.
 *
 * The bar paints the same `bg-background` the chat pane sits on —
 * no tinted plate, no visible separator. The only thing marking the
 * crease is a `color-mix(... var(--background) ..., transparent)`
 * gradient overlay at the top of the scroll area that lets messages
 * dissolve under the bar as they scroll up. Same recipe as the
 * sidebar's footer fade (`SidebarFooter`) so the chrome reads
 * consistent across surfaces. The overlay is `pointer-events-none`
 * so it never intercepts scroll / clicks.
 */
export function ChatTitleBar({
  chat,
  sessionId,
  hasOverflow,
}: ChatTitleBarProps) {
  const session = useDb(root =>
    sessionId ? root.app.sessions[sessionId] : undefined,
  )
  const scope = useDb(root => root.app.scopes[chat.scopeId])
  const repoId = scope?.repoId ?? null
  const repo = useDb(root => (repoId ? root.app.repos[repoId] : undefined))
  const workspaceId = scope?.workspaceId ?? null
  const workspace = useDb(root =>
    workspaceId ? root.app.workspaces[workspaceId] : undefined,
  )
  // Count active (non-archived) scopes in this workspace.
  // When there's exactly one, the workspace is in its
  // "simple" mode — no worktree fan-out — and surfacing a branch
  // name would expose plumbing the user hasn't been introduced to
  // yet. Mirrors the sidebar's “skip the worktree group wrapper
  // when sidebarGroups.length === 1” behavior so the two surfaces
  // stay aligned on what counts as “simple”.
  const workspaceScopeCount = useDb(root => {
    if (!workspaceId) return 0
    let n = 0
    for (const s of Object.values(root.app.scopes)) {
      if (s.workspaceId !== workspaceId) continue
      if (s.archived) continue
      n++
    }
    return n
  })
  const hasWorktreeFanout = workspaceScopeCount > 1

  const { label } = resolveChatLabel(chat, session)
  const scopeLabel = scope
    ? hasWorktreeFanout
      ? scopeBranchOrBasename(scope, repo ?? null)
      : workspace?.name ?? null
    : null
  const showScope =
    !!scopeLabel && scopeLabel.toLowerCase() !== label.toLowerCase()

  return (
    // No `z-index` and no opaque `bg-background` on this subtree.
    // The chat pane's outer wrapper already paints `bg-background`,
    // so the title bar's text reads on the same surface without us
    // double-painting. Critically, painting bg here from inside the
    // chat pane's `relative z-10` content layer would land at z=10
    // in the host splitView's stacking context — the Allotment
    // separator pseudo at the left edge is bumped to z=50 to clear
    // app content, but the title bar's *opaque* background would
    // still visually replace the pixels under it where the
    // separator should show through. Letting the chat pane's outer
    // bg (at z=auto) provide the surface keeps the separator
    // (z=50) visible across the top-left corner.
    //
    // `z-10` on this wrapper is what makes the bottom fade overlay
    // actually work. The overlay below is `position: absolute;
    // top: 100%`, so it lives in the same pixel rows as the top of
    // the sibling `<ChatDisplay />`. Without an explicit stacking
    // context here, both subtrees paint at `z-auto` and DOM order
    // wins — ChatDisplay comes second so it paints *over* the
    // fade, leaving a hard horizontal edge. Bumping the title bar
    // root to z-10 keeps the text in its existing visual plane
    // (the text is opaque anyway) while pulling the fade overlay
    // above ChatDisplay so messages actually dissolve under the
    // bar's bottom edge. Same idea as `relative z-10` on the chat
    // pane content layer one level up.
    <div className="relative z-10 shrink-0">
      <div className="flex items-center gap-2 px-4 py-2 text-[12px]">
        {showScope ? (
          <>
            <span className="truncate text-muted-foreground">
              {scopeLabel}
            </span>
            <span className="text-muted-foreground/60">/</span>
          </>
        ) : null}
        <span className="truncate font-medium text-foreground/90">
          {label}
        </span>
      </div>
      {/* Soft fade overlay sitting at the top of the scroll area.
       * Only rendered when the chat is actually scrollable; on a
       * pristine "New Chat" with nothing below the bar, the fade
       * would just cast a phantom shadow into empty pane background.
       * Recipe matches `SidebarFooter` (inverted vertically) so the
       * two surfaces share the same fade feel. */}
      {hasOverflow ? (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-full"
          style={{
            height: CHAT_TITLE_FADE,
            background: `linear-gradient(
              to bottom,
              var(--background) 0%,
              color-mix(in srgb, var(--background) 85%, transparent) 4px,
              color-mix(in srgb, var(--background) 0%, transparent) ${CHAT_TITLE_FADE}px
            )`,
          }}
        />
      ) : null}
    </div>
  )
}

/**
 * Branch name when the scope is backed by a tracked worktree, else
 * the directory's basename. Mirrors `worktreeGroupLabel` in the
 * sidebar so the two surfaces stay in sync without sharing a module
 * (the sidebar version is colocated with its scope/repo types).
 *
 * Only used when the workspace has worktree fan-out (>1 active
 * scope). In the single-scope case we fall back to the workspace
 * name instead so the title doesn't surface git-worktree plumbing
 * before the user has opted into it.
 */
function scopeBranchOrBasename(scope: Scope, repo: Repo | null): string {
  if (repo) {
    const wt = repo.worktrees.find(w => w.path === scope.directory)
    if (wt?.branch) return wt.branch
  }
  const parts = scope.directory.split("/").filter(Boolean)
  return parts[parts.length - 1] ?? scope.directory
}

