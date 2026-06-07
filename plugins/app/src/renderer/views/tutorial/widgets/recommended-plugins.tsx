import { useCallback, useContext, useEffect, useMemo, useState } from "react"
import { useInjections, useRpc } from "@zenbujs/core/react"
import { z } from "zod"
import {
  useLeftSidebarTab,
  useSetLeftSidebarOpen,
  useSetLeftSidebarTab,
} from "../../../lib/window-state/workspace-ui"
import {
  useBottomPanelView,
  useRightSidebarOpenType,
  useSetBottomPanelOpen,
  useSetBottomPanelView,
  useSetRightSidebarOpenType,
} from "../../../lib/window-state/scope-ui"
import { LiveWidgetAckContext } from "../ack-context"
import { EnableButton, PrimaryWidgetAction, WidgetCard } from "./primitives"

function prettifyPluginName(name: string): string {
  const spaced = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

// Runtime validation of the `pluginManager.list()` RPC response.
const pluginManifestRowSchema = z.object({
  path: z.string(),
  manifestPath: z.string(),
  name: z.string().nullable(),
  enabled: z.boolean(),
  args: z.unknown().optional(),
})
const pluginManagerListResponseSchema = z.object({
  rows: z.array(pluginManifestRowSchema),
  manifestPaths: z.array(z.string()),
})
type PluginManifestRow = z.infer<typeof pluginManifestRowSchema>

/** `.../plugins/<folder>/zenbu.plugin.ts` → `<folder>`. Matched
 * by folder since disabled rows report `name: null`. */
function folderNameFromPluginPath(p: string): string {
  const parts = p.split(/[\\/]/)
  return parts[parts.length - 2] ?? ""
}

/** Which surface to open once a plugin is enabled. `viewName` is
 * both the injection name we wait for and the id written into
 * window state. */
type RevealAction =
  | { surface: "left"; viewName: string }
  | { surface: "right"; viewName: string }
  | { surface: "bottom"; viewName: string }
  // No surface to reveal (e.g. title-bar items). Enabling the
  // plugin is the whole interaction; nothing opens.
  | { surface: "none" }

type RecommendedPlugin = {
  /** Plugin folder name (matches `plugins/<name>/`). */
  name: string
  tagline: string
  reveal: RevealAction
  /** Only surface / auto-enable when git is installed. */
  requiresGit?: boolean
}

/** The core UI plugins the tutorial walks the user through. */
const RECOMMENDED: RecommendedPlugin[] = [
  {
    name: "agent-sidebar",
    tagline: "Manage agents and worktrees",
    reveal: { surface: "left", viewName: "agent" },
  },
  {
    name: "context-sidebar",
    tagline: "View and manage your agent's context",
    reveal: { surface: "right", viewName: "context-sidebar" },
  },
  {
    name: "file-tree-sidebar",
    tagline: "View files, folders, and open them inside Zenbu",
    reveal: { surface: "right", viewName: "file-tree-sidebar" },
  },
  {
    name: "git-tree-sidebar",
    tagline: "View changed files and their diffs",
    reveal: { surface: "right", viewName: "git-tree-sidebar" },
    requiresGit: true,
  },
  {
    name: "commit-button",
    tagline: "Commit changes right from the title bar",
    reveal: { surface: "none" },
    requiresGit: true,
  },
]

/**
 * Enable every recommended plugin with NO side effects: just flip the
 * manifest rows on (idempotent), without revealing any surface or showing
 * the per-plugin "Enable" reveal the tutorial widget does. Used when the
 * user leaves onboarding (Skip tutorial / Open project / continue) without
 * having toggled them by hand — we still want the core sidebars on.
 *
 * git-tree-sidebar is only enabled when git is actually installed, matching
 * what the tutorial card shows.
 */
export async function enableRecommendedPluginsNoSideEffects(
  rpc: ReturnType<typeof useRpc>,
): Promise<void> {
  let gitAvailable = true
  try {
    gitAvailable = await rpc.app.repos.isGitInstalled()
  } catch {
    gitAvailable = true // assume present on error, same as the widget
  }

  let rows: PluginManifestRow[]
  try {
    const raw = await rpc.core.pluginManager.list()
    const parsed = pluginManagerListResponseSchema.safeParse(raw)
    if (!parsed.success) return
    rows = parsed.data.rows
  } catch (err) {
    console.error("[tutorial] enableRecommended: list failed:", err)
    return
  }

  const wanted = new Set(
    RECOMMENDED.filter(r => (r.requiresGit ? gitAvailable : true)).map(
      r => r.name,
    ),
  )

  await Promise.all(
    rows
      .filter(
        row =>
          wanted.has(folderNameFromPluginPath(row.path)) && !row.enabled,
      )
      .map(row =>
        rpc.core.pluginManager
          .setEnabled({ path: row.path, enabled: true })
          .catch((err: unknown) =>
            console.error(
              `[tutorial] enableRecommended: setEnabled(${row.path}) failed:`,
              err,
            ),
          ),
      ),
  )
}

/** Card listing the core UI plugins with real enable/disable
 * toggles that also reveal each surface. */
export function RecommendedPluginsWidget() {
  // Live plugin manifest state. `rows == null` while the initial
  // RPC is in flight; we render the toggle as disabled until
  // it lands so the user can't fire a setEnabled before we
  // know what the current state is.
  const rpc = useRpc()
  const [rows, setRows] = useState<PluginManifestRow[] | null>(null)
  const [busy, setBusy] = useState<Set<string>>(() => new Set())

  const refresh = useCallback(async () => {
    try {
      const raw = await rpc.core.pluginManager.list()
      const parsed = pluginManagerListResponseSchema.safeParse(raw)
      if (!parsed.success) {
        console.warn(
          "[tutorial] pluginManager.list returned an unexpected shape:",
          parsed.error,
        )
        return
      }
      setRows(parsed.data.rows)
    } catch (err) {
      console.error("[tutorial] pluginManager.list failed:", err)
    }
  }, [rpc])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Hide the Git sidebar recommendation when git isn't installed.
  const [gitAvailable, setGitAvailable] = useState<boolean | null>(null)
  useEffect(() => {
    let cancelled = false
    void rpc.app.repos
      .isGitInstalled()
      .then(ok => {
        if (!cancelled) setGitAvailable(ok)
      })
      .catch(err => {
        console.error("[tutorial] isGitInstalled failed:", err)
        if (!cancelled) setGitAvailable(true) // assume present on error
      })
    return () => {
      cancelled = true
    }
  }, [rpc])

  const recommended = useMemo(
    () =>
      RECOMMENDED.filter(r =>
        r.requiresGit ? gitAvailable === true : true,
      ),
    [gitAvailable],
  )

  const rowByName = useMemo(() => {
    const map = new Map<string, PluginManifestRow>()
    if (!rows) return map
    for (const r of rows) {
      const folder = folderNameFromPluginPath(r.path)
      if (folder) map.set(folder, r)
    }
    return map
  }, [rows])

  // ---- reveal machinery ----
  // Enabling a plugin only registers its injection; we then drive
  // window state to open the surface. But we wait until the
  // injection actually appears in the registry (`pendingReveal`
  // below) since the right sidebar auto-closes an unregistered
  // view.
  const setLeftSidebarOpen = useSetLeftSidebarOpen()
  const setLeftSidebarTab = useSetLeftSidebarTab()
  const setRightSidebarOpenType = useSetRightSidebarOpenType()
  const setBottomPanelOpen = useSetBottomPanelOpen()
  const setBottomPanelView = useSetBottomPanelView()
  const leftSidebarTab = useLeftSidebarTab()
  const rightSidebarOpenType = useRightSidebarOpenType()
  const bottomPanelView = useBottomPanelView()

  const leftInjections = useInjections({ kind: "left-sidebar" })
  const rightInjections = useInjections({ kind: "right-sidebar" })
  const bottomInjections = useInjections({ kind: "bottom-panel" })
  const registeredNames = useMemo(() => {
    const left = new Set(leftInjections.map(i => i.name))
    const right = new Set(rightInjections.map(i => i.name))
    const bottom = new Set(bottomInjections.map(i => i.name))
    return { left, right, bottom }
  }, [leftInjections, rightInjections, bottomInjections])

  const applyReveal = useCallback(
    (reveal: RevealAction) => {
      if (reveal.surface === "left") {
        setLeftSidebarOpen(true)
        setLeftSidebarTab(reveal.viewName)
      } else if (reveal.surface === "right") {
        setRightSidebarOpenType(reveal.viewName)
      } else if (reveal.surface === "bottom") {
        setBottomPanelOpen(true)
        setBottomPanelView(reveal.viewName)
      }
      // "none": nothing to reveal.
    },
    [
      setLeftSidebarOpen,
      setLeftSidebarTab,
      setRightSidebarOpenType,
      setBottomPanelOpen,
      setBottomPanelView,
    ],
  )

  // Hide a plugin's surface on disable, but only if it's the one
  // currently showing.
  const hideReveal = useCallback(
    (reveal: RevealAction) => {
      if (reveal.surface === "left") {
        if (leftSidebarTab === reveal.viewName) setLeftSidebarOpen(false)
      } else if (reveal.surface === "right") {
        if (rightSidebarOpenType === reveal.viewName)
          setRightSidebarOpenType(null)
      } else if (reveal.surface === "bottom") {
        if (bottomPanelView === reveal.viewName) setBottomPanelOpen(false)
      }
      // "none": nothing to hide.
    },
    [
      leftSidebarTab,
      rightSidebarOpenType,
      bottomPanelView,
      setLeftSidebarOpen,
      setRightSidebarOpenType,
      setBottomPanelOpen,
    ],
  )

  // Plugins waiting to be revealed once their injection registers.
  const [pendingReveal, setPendingReveal] = useState<Set<string>>(
    () => new Set(),
  )
  useEffect(() => {
    if (pendingReveal.size === 0) return
    let changed = false
    const next = new Set(pendingReveal)
    for (const folder of pendingReveal) {
      const entry = RECOMMENDED.find(r => r.name === folder)
      if (!entry || entry.reveal.surface === "none") {
        next.delete(folder)
        changed = true
        continue
      }
      const slot =
        entry.reveal.surface === "left"
          ? registeredNames.left
          : entry.reveal.surface === "right"
            ? registeredNames.right
            : registeredNames.bottom
      if (slot.has(entry.reveal.viewName)) {
        applyReveal(entry.reveal)
        next.delete(folder)
        changed = true
      }
    }
    if (changed) setPendingReveal(next)
  }, [pendingReveal, registeredNames, applyReveal])

  const togglePlugin = useCallback(
    async (name: string) => {
      const row = rowByName.get(name)
      if (!row) {
        console.warn(
          `[tutorial] toggle: no manifest row for "${name}" \u2014 ignoring`,
        )
        return
      }
      if (busy.has(name)) return
      const enabling = !row.enabled
      const entry = RECOMMENDED.find(r => r.name === name)
      setBusy(prev => {
        const next = new Set(prev)
        next.add(name)
        return next
      })
      try {
        await rpc.core.pluginManager.setEnabled({
          path: row.path,
          enabled: enabling,
        })
        await refresh()
        if (entry) {
          if (enabling) {
            // Queue the reveal (fired once the injection registers).
            // Title-bar items (`surface: "none"`) have nothing to
            // reveal, so skip queuing them.
            if (entry.reveal.surface !== "none") {
              setPendingReveal(prev => {
                const nextSet = new Set(prev)
                nextSet.add(name)
                return nextSet
              })
            }
          } else {
            setPendingReveal(prev => {
              if (!prev.has(name)) return prev
              const nextSet = new Set(prev)
              nextSet.delete(name)
              return nextSet
            })
            hideReveal(entry.reveal)
          }
        }
      } catch (err) {
        console.error(
          `[tutorial] setEnabled(${name}, ${enabling}) failed:`,
          err,
        )
      } finally {
        setBusy(prev => {
          const next = new Set(prev)
          next.delete(name)
          return next
        })
      }
    },
    [rpc, rowByName, refresh, busy, hideReveal],
  )
  const ackLive = useContext(LiveWidgetAckContext)

  // Capped width so the Enable button stays near its row.
  return (
    <div className="max-w-[440px]">
      <WidgetCard>
        <ul className="flex flex-col">
          {recommended.map(r => {
            const row = rowByName.get(r.name)
            const sel = row?.enabled ?? false
            // Disabled until the row loads / while a toggle is pending.
            const buttonDisabled = !row || busy.has(r.name)
            const label = prettifyPluginName(r.name)
            return (
              <li
                key={r.name}
                className={
                  "flex items-center gap-3 px-3 py-2 text-[13px] " +
                  (sel ? "text-foreground" : "text-foreground/70")
                }
              >
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-medium">{label}</span>
                  <span className="truncate text-[11.5px] text-muted-foreground">
                    {r.tagline}
                  </span>
                </span>
                <EnableButton
                  enabled={sel}
                  disabled={buttonDisabled}
                  onClick={() => void togglePlugin(r.name)}
                />
              </li>
            )
          })}
        </ul>

        {ackLive ? (
          <div className="flex items-center justify-start border-t border-border/60 bg-card/40 px-3 py-2.5">
            <PrimaryWidgetAction onClick={ackLive}>
              Okay, done!
            </PrimaryWidgetAction>
          </div>
        ) : null}
      </WidgetCard>
    </div>
  )
}
