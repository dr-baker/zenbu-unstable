import { Service, runtime } from "@zenbujs/core/runtime"
import {
  RpcService,
  ShortcutsService,
  type ShortcutDef,
} from "@zenbujs/core/services"
// `ShortcutBinding` is the raw key+modifier record stored inside a
// `ShortcutDef.defaultBinding`. Upstream moved it out of the
// `@zenbujs/core/services` public surface and into the shared
// schema module, since it's part of the persisted shortcut payload
// (not a service handle). The other shortcut symbols stay where
// they are.
import type { ShortcutBinding } from "@zenbujs/core/schema"
import { PaletteActionsService } from "./palette-actions"

const IS_MAC = process.platform === "darwin"

type Mods = {
  key?: string
  code?: string
  meta?: boolean
  control?: boolean
  alt?: boolean
  shift?: boolean
}

const mod = (extra: Mods = {}): Mods =>
  IS_MAC ? { meta: true, ...extra } : { control: true, ...extra }

/**
 * Single-source-of-truth declaration for an action exposed by this
 * service. Each entry potentially produces TWO registrations:
 *
 *   1. A core `shortcuts.register(...)` so the keystroke fires the
 *      handler from anywhere in the app (iframes included).
 *   2. A `paletteActions.register(...)` so the same action shows up
 *      in the command palette and dispatches the same code path.
 *
 * Both registrations share the same metadata (`name`, `category`,
 * `description`, `defaultBinding`) so they can never drift. The
 * shortcut handler and the palette dispatch both call a public
 * method on this service identified by `method` — same code path,
 * different surface.
 *
 * Skipping the palette: setting `palette: false` (or having a
 * `when` clause, which auto-skips) keeps the action keyboard-only.
 * Sidebar j/k/h/l are good examples — they belong to a focus
 * context, not the global palette.
 *
 * Parameterized actions: `paletteArgs` is spread into the
 * dispatch args so the same RPC method can back many palette
 * rows (e.g. `focusPane` + `{ index: N }` for Cmd+1..9).
 */
type Action = {
  /** Shortcut id, also used as the palette action id. Convention:
   * `app.<verb-noun>`. */
  id: string
  name: string
  category: ShortcutDef["category"]
  description: string
  defaultBinding: ShortcutBinding | ShortcutBinding[]
  when?: ShortcutDef["when"]
  /** Public method on this service to invoke. Both the shortcut
   * handler and the palette dispatch call this. */
  method: string
  /** Extra args merged into both the shortcut handler invocation
   * and the palette dispatch. Lets one method back multiple
   * actions (e.g. focusPane × 9). */
  paletteArgs?: Record<string, unknown>
  /** Override the palette label. Defaults to `name`. */
  paletteLabel?: string
  /** Explicit opt-out of palette registration. Defaults to
   * `false` when `when` is set, `true` otherwise. */
  palette?: boolean
}

/**
 * Format a binding for the palette hint column. Picks the first
 * binding from an array (the "primary" accelerator), maps modifier
 * flags to glyphs, and joins by no separator (mirroring how macOS
 * menus render shortcuts: `⌘⇧P`, not `⌘ + ⇧ + P`).
 */
function formatBinding(
  binding: ShortcutBinding | ShortcutBinding[],
): string | null {
  const first = Array.isArray(binding) ? binding[0] : binding
  if (!first) return null
  const parts: string[] = []
  if (first.control) parts.push(IS_MAC ? "⌃" : "Ctrl+")
  if (first.alt) parts.push(IS_MAC ? "⌥" : "Alt+")
  if (first.shift) parts.push(IS_MAC ? "⇧" : "Shift+")
  if (first.meta) parts.push(IS_MAC ? "⌘" : "Win+")
  const key = first.key ?? ""
  // Display a single character uppercased ("p" → "P"), and replace
  // a couple of common control names with their glyphs.
  const display =
    key === "ArrowDown"
      ? "↓"
      : key === "ArrowUp"
        ? "↑"
        : key === "ArrowLeft"
          ? "←"
          : key === "ArrowRight"
            ? "→"
            : key === " "
              ? "Space"
              : key.length === 1
                ? key.toUpperCase()
                : key
  parts.push(display)
  return parts.join("")
}

/**
 * Wires the app's UI shortcuts into the core `ShortcutsService` AND
 * the host's `PaletteActionsService` from one declaration. Each
 * action's handler is a public method on this service so the
 * keyboard and the palette both fire the exact same code path.
 *
 * The actual keystroke capture lives in the prelude that core
 * injects into every iframe; this service has no main-process
 * listeners anymore. That gives us:
 *   - shortcuts that work identically in the browser-only dev URL
 *   - per-shortcut configurability (`core.shortcuts` in the DB +
 *     the Shortcuts settings UI in the renderer)
 *   - palette discovery for free, sharing names + descriptions +
 *     bindings with the settings UI
 *   - one place (this file) where the host adds new actions
 */
export class ShortcutsService_App extends Service.create({
  key: "app-shortcuts",
  deps: {
    rpc: RpcService,
    shortcuts: ShortcutsService,
    paletteActions: PaletteActionsService,
  },
}) {
  // ---- action handlers --------------------------------------------
  //
  // One public method per action. The shortcut def's handler and the
  // palette dispatch both end up here, so both surfaces fire the same
  // event with a consistent `source`. The `source` is informational
  // only — subscribers don't typically care, but it's useful for
  // debugging the "did this come from a key press or a click?".

  toggleCommandPalette() {
    this.ctx.rpc.emit.app.toggleCommandPalette({ source: "action" })
  }
  toggleAgentsPalette() {
    this.ctx.rpc.emit.app.toggleAgentsPalette({ source: "action" })
  }
  toggleTerminal() {
    this.ctx.rpc.emit.app.toggleTerminal({ source: "action" })
  }
  toggleSidebar() {
    this.ctx.rpc.emit.app.toggleSidebar({ source: "action" })
  }
  toggleRightSidebar() {
    this.ctx.rpc.emit.app.toggleRightSidebar({ source: "action" })
  }
  toggleWorkspaceRail() {
    this.ctx.rpc.emit.app.toggleWorkspaceRail({ source: "action" })
  }
  newChatInCurrentPane() {
    this.ctx.rpc.emit.app.newChatInCurrentPane({ source: "action" })
  }
  newChatReplaceActive() {
    this.ctx.rpc.emit.app.newChatReplaceActive({ source: "action" })
  }
  splitPaneSameSession() {
    this.ctx.rpc.emit.app.splitPaneSameSession({ source: "action" })
  }
  splitPaneNewChat() {
    this.ctx.rpc.emit.app.splitPaneNewChat({ source: "action" })
  }
  closeActivePane() {
    this.ctx.rpc.emit.app.closeActivePane({ source: "action" })
  }
  focusSidebar() {
    this.ctx.rpc.emit.app.focusSidebar({ source: "action" })
  }
  focusPane(args: { index: number }) {
    this.ctx.rpc.emit.app.focusPane({ index: args.index, source: "action" })
  }
  navigateTabPrev() {
    this.ctx.rpc.emit.app.navigateTabs({ dir: "prev", source: "action" })
  }
  navigateTabNext() {
    this.ctx.rpc.emit.app.navigateTabs({ dir: "next", source: "action" })
  }
  focusActiveComposer() {
    this.ctx.rpc.emit.app.focusActiveComposer({ source: "action" })
  }
  // Sidebar j/k/h/l/Space/Ctrl+d/Ctrl+u shortcuts used to live
  // here; they're now auto-registered by `<ListNav
  // id="agent-sidebar">` via the `listNav` service (see
  // `services/list-nav.ts` and `packages/ui/src/list-nav.tsx`).
  openSettings(args?: {
    tab?: "general" | "accounts" | "shortcuts" | "plugins"
    sectionId?: string
  }) {
    this.ctx.rpc.emit.app.openSettings({
      source: "action",
      ...(args?.tab ? { tab: args.tab } : {}),
      ...(args?.sectionId ? { sectionId: args.sectionId } : {}),
    })
  }

  // Terminal-context handlers (gated by `when: "app.terminal"` or
  // `when: "app.terminal.tabs"` below). The renderer's terminal view
  // installs both focus contexts; it subscribes to these events and
  // handles the actual create / focus / nav work since DOM focus +
  // pty state live there.
  terminalNew() {
    this.ctx.rpc.emit.app.terminalNew({ source: "action" })
  }
  terminalFocusTabs() {
    this.ctx.rpc.emit.app.terminalFocusTabs({ source: "action" })
  }
  terminalFocusActive() {
    this.ctx.rpc.emit.app.terminalFocusActive({ source: "action" })
  }
  terminalTabsMoveDown() {
    this.ctx.rpc.emit.app.terminalTabsMove({ dir: "down", source: "action" })
  }
  terminalTabsMoveUp() {
    this.ctx.rpc.emit.app.terminalTabsMove({ dir: "up", source: "action" })
  }
  terminalTabsActivate() {
    this.ctx.rpc.emit.app.terminalTabsActivate({ source: "action" })
  }
  terminalTabsClose() {
    this.ctx.rpc.emit.app.terminalTabsClose({ source: "action" })
  }

  /**
   * The canonical action list. Order matters only for the palette
   * (alphabetised in the renderer anyway). Pane-focus rows are
   * appended programmatically below to avoid 9 near-identical
   * literal entries.
   */
  private static buildActions(): Action[] {
    const actions: Action[] = [
      // Navigation
      {
        id: "app.toggleCommandPalette",
        name: "Toggle Command Palette",
        category: "Navigation",
        description:
          "Open the global command palette (search across commands and chats).",
        defaultBinding: mod({ key: "p", shift: true }),
        method: "toggleCommandPalette",
      },
      {
        id: "app.toggleAgentsPalette",
        name: "Toggle Agents Palette",
        category: "Navigation",
        description:
          "Open the agents palette — a focused fuzzy picker for chats.",
        defaultBinding: mod({ key: "p" }),
        method: "toggleAgentsPalette",
      },
      {
        id: "app.focusSidebar",
        name: "Focus Sidebar",
        category: "Navigation",
        description:
          "Move keyboard focus to the agent sidebar so j/k/space etc. start firing.",
        defaultBinding: mod({ key: "s", shift: true }),
        method: "focusSidebar",
      },
      {
        id: "app.navigateTabPrev",
        name: "Previous Tab",
        category: "Navigation",
        description:
          "Activate the previous tab in the active pane. Wraps to the last tab at the left edge. Mirrors Safari / Chrome / Finder ⌘⇧[.",
        // Holding shift turns `[` into `{` on US layouts; register
        // both `key` values against the same physical code so the
        // chord fires regardless of which one the OS surfaces.
        defaultBinding: [
          { ...mod({ shift: true }), key: "[", code: "BracketLeft" },
          { ...mod({ shift: true }), key: "{", code: "BracketLeft" },
        ],
        method: "navigateTabPrev",
      },
      {
        id: "app.navigateTabNext",
        name: "Next Tab",
        category: "Navigation",
        description:
          "Activate the next tab in the active pane. Wraps to the first tab at the right edge. Mirrors Safari / Chrome / Finder ⌘⇧].",
        defaultBinding: [
          { ...mod({ shift: true }), key: "]", code: "BracketRight" },
          { ...mod({ shift: true }), key: "}", code: "BracketRight" },
        ],
        method: "navigateTabNext",
      },
      {
        id: "app.focusActiveComposer",
        name: "Focus Chat Input",
        category: "Navigation",
        description:
          "Move keyboard focus to the composer of the chat in the active pane.",
        defaultBinding: mod({ key: "l" }),
        method: "focusActiveComposer",
      },
      {
        id: "app.openSettings",
        name: "Settings",
        category: "Navigation",
        description:
          "Open the Settings view in a new tab in the active pane.",
        defaultBinding: mod({ key: "," }),
        method: "openSettings",
        paletteLabel: "Settings",
      },

      // Panels
      {
        id: "app.toggleTerminal",
        name: "Toggle Terminal",
        category: "Panels",
        description: "Show/hide the bottom terminal panel.",
        defaultBinding: mod({ key: "j" }),
        method: "toggleTerminal",
      },
      {
        id: "app.toggleSidebar",
        name: "Toggle Sidebar",
        category: "Panels",
        description: "Show/hide the left agent sidebar.",
        defaultBinding: mod({ key: "b" }),
        method: "toggleSidebar",
      },
      {
        id: "app.toggleRightSidebar",
        name: "Toggle Right Sidebar",
        category: "Panels",
        description: "Show/hide the right sidebar (mirrors Cmd+B for the left).",
        defaultBinding: mod({ key: "g" }),
        method: "toggleRightSidebar",
      },
      {
        id: "app.toggleWorkspaceRail",
        name: "Toggle Workspace Rail",
        category: "Panels",
        description:
          "Show/hide the narrow workspace rail on the far left.",
        defaultBinding: mod({ key: "b", shift: true }),
        method: "toggleWorkspaceRail",
      },

      // Chats
      {
        id: "app.newChatInCurrentPane",
        name: "New Chat in Current Pane",
        category: "Chats",
        description: "Open a new chat in the active pane (appends a tab).",
        defaultBinding: mod({ key: "t" }),
        method: "newChatInCurrentPane",
      },
      {
        id: "app.newChatReplaceActive",
        name: "New Chat (replace active tab)",
        category: "Chats",
        description: "Replace the active tab's chat with a fresh one.",
        defaultBinding: mod({ key: "n" }),
        method: "newChatReplaceActive",
      },

      // Panes
      {
        id: "app.splitPaneSameSession",
        name: "Split Pane (same session)",
        category: "Panes",
        description: "Split the active pane and mirror the current session.",
        defaultBinding: [
          { ...mod(), key: "/", code: "Slash" },
          { ...mod(), key: "\\", code: "Backslash" },
        ],
        method: "splitPaneSameSession",
      },
      {
        id: "app.splitPaneNewChat",
        name: "Split Pane (new chat)",
        category: "Panes",
        description: "Split the active pane and open a brand-new chat there.",
        defaultBinding: [
          { ...mod({ shift: true }), key: "/", code: "Slash" },
          { ...mod({ shift: true }), key: "?", code: "Slash" },
          { ...mod({ shift: true }), key: "\\", code: "Backslash" },
          { ...mod({ shift: true }), key: "|", code: "Backslash" },
        ],
        method: "splitPaneNewChat",
      },
      {
        id: "app.closeActivePane",
        name: "Close Active Pane",
        category: "Panes",
        description: "Close the active pane (no-op on a single pane).",
        defaultBinding: mod({ key: "w" }),
        method: "closeActivePane",
      },

      // Note: the eight per-list shortcuts (j/k/h/l, Ctrl+d/u,
      // Space, Enter) used to live here gated on
      // `when: "app.sidebar"`. They're now registered
      // dynamically by `<ListNav id="…">` instances via the
      // `listNav` service (see `services/list-nav.ts`), so each
      // list-nav scope on screen — the agent sidebar, file tree,
      // marketplace columns, etc. — gets its own settings
      // category instead of sharing one global "Sidebar" group.

      // Terminal — a top-level `app.terminal` context covers the whole
      // bottom-panel view, with a nested `app.terminal.tabs` context
      // on the right-side tab strip for vim-style navigation. The
      // prelude collects all contexts up the DOM chain, so being
      // focused in the tabs strip activates both — which is why the
      // "new terminal" / "focus tabs" shortcuts only need the
      // broader `app.terminal` gate.
      {
        id: "app.terminal.new",
        name: "Terminal: New Terminal",
        category: "Terminal",
        description: "Spawn a new terminal in the current scope.",
        defaultBinding: mod({ key: "t", shift: true }),
        when: "app.terminal",
        method: "terminalNew",
      },
      {
        id: "app.terminal.focusTabs",
        name: "Terminal: Focus Tab List",
        category: "Terminal",
        description:
          "Move keyboard focus from the active terminal to the right-side tab list so j/k navigate tabs.",
        defaultBinding: { key: "`", control: true },
        when: "app.terminal",
        method: "terminalFocusTabs",
      },
      {
        id: "app.terminal.tabs.focusActive",
        name: "Terminal: Return to Active Terminal",
        category: "Terminal",
        description:
          "Return keyboard focus from the tab list to the active terminal pane.",
        defaultBinding: [
          { key: "`", control: true },
          { key: "Escape" },
        ],
        when: "app.terminal.tabs",
        method: "terminalFocusActive",
      },
      {
        id: "app.terminal.tabs.moveDown",
        name: "Terminal Tabs: Next",
        category: "Terminal",
        description: "Select the next terminal in the tab list.",
        defaultBinding: [{ key: "j" }, { key: "ArrowDown" }],
        when: "app.terminal.tabs",
        method: "terminalTabsMoveDown",
      },
      {
        id: "app.terminal.tabs.moveUp",
        name: "Terminal Tabs: Previous",
        category: "Terminal",
        description: "Select the previous terminal in the tab list.",
        defaultBinding: [{ key: "k" }, { key: "ArrowUp" }],
        when: "app.terminal.tabs",
        method: "terminalTabsMoveUp",
      },
      {
        id: "app.terminal.tabs.activate",
        name: "Terminal Tabs: Activate Selection",
        category: "Terminal",
        description:
          "Focus the active terminal pane (exits tab-nav mode).",
        defaultBinding: [
          { key: " ", code: "Space" },
          { key: "Enter" },
        ],
        when: "app.terminal.tabs",
        method: "terminalTabsActivate",
      },
      {
        id: "app.terminal.tabs.close",
        name: "Terminal Tabs: Close Selected",
        category: "Terminal",
        description: "Close the currently selected terminal.",
        defaultBinding: { key: "x" },
        when: "app.terminal.tabs",
        method: "terminalTabsClose",
      },
    ]

    // Pane focus rows: Cmd+1 … Cmd+9. One shortcut + one palette
    // action per pane, all backed by the single `focusPane` method
    // with `paletteArgs: { index: N }`.
    for (let i = 1; i <= 9; i++) {
      actions.push({
        id: `app.focusPane${i}`,
        name: `Focus Pane ${i}`,
        category: "Navigation",
        description:
          i === 1
            ? "Focus the leftmost pane in the active scope."
            : `Focus pane ${i} in the active scope.${i === 2 ? " Splits the active pane if pane 2 doesn't exist yet." : ""}`,
        defaultBinding: mod({ key: String(i) }),
        method: "focusPane",
        paletteArgs: { index: i },
      })
    }

    return actions
  }

  evaluate() {
    const ACTIONS = ShortcutsService_App.buildActions()

    // 1. Register the shortcuts (keyboard side) on the core bus.
    //    Each handler invokes the same public method the palette
    //    dispatches to, plus the `paletteArgs` merged in (so
    //    `focusPane3`'s shortcut calls `this.focusPane({ index: 3 })`).
    this.setup("register-shortcuts", () => {
      const unsubs: Array<() => void> = []
      for (const a of ACTIONS) {
        const handler = () => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const fn = (this as any)[a.method] as
            | undefined
            | ((args?: Record<string, unknown>) => void)
          if (typeof fn !== "function") {
            console.error(
              "[shortcuts] handler method missing on service:",
              a.method,
              "for shortcut",
              a.id,
            )
            return
          }
          fn.call(this, a.paletteArgs ?? {})
        }
        unsubs.push(
          this.ctx.shortcuts.register({
            id: a.id,
            name: a.name,
            category: a.category,
            description: a.description,
            defaultBinding: a.defaultBinding,
            when: a.when,
            handler,
          }),
        )
      }
      return () => {
        for (const u of unsubs) {
          try {
            u()
          } catch {}
        }
      }
    })

    // 2. Register one palette action per action — except actions
    //    that are explicitly keyboard-only (focus-context-scoped via
    //    `when`, or `palette: false`). Hint is derived from the
    //    default binding so the palette and the shortcuts UI never
    //    disagree on which key is bound.
    for (const a of ACTIONS) {
      const includeInPalette = a.palette ?? a.when === undefined
      if (!includeInPalette) continue

      this.setup(`palette-action:${a.id}`, () => {
        void this.ctx.paletteActions.register({
          id: a.id,
          label: a.paletteLabel ?? a.name,
          hint: formatBinding(a.defaultBinding),
          // Service key is `"app-shortcuts"`; renderer dispatches
          // `rpc.app["app-shortcuts"][method]({windowId, ...args})`.
          rpc: { plugin: "app", service: "app-shortcuts", method: a.method },
          args: a.paletteArgs,
        })
        return () => {
          void this.ctx.paletteActions.unregister({ id: a.id })
        }
      })
    }
  }
}

runtime.register(ShortcutsService_App, import.meta)
