import { definePlugin } from "@zenbujs/core/config";

/**
 * Context-window right-sidebar plugin.
 *
 * Contributes a single `rendering: "component"` view,
 * `context-sidebar`, tagged with `meta.kind = "view"` +
 * `meta.sidebar = true` so the host's right-sidebar surface
 * picks it up.
 *
 * The view renders, top-to-bottom:
 *   - the active session's header (title, model, ctx totals)
 *   - a fixed cells × rows context-window grid
 *   - the active scope's "extra directories" (formerly a
 *     dedicated `extra-dirs-sidebar` plugin) with reveal /
 *     copy / remove + an inline "Add dir to context" button
 *   - the session footer (cumulative tokens, cost, leaves, …)
 *
 * Because component views share the host's React tree, the
 * view reads `root.pi.sessions[...]` / `root.app.scopes[...]`
 * straight off the host's replica and mutates extraDirectories
 * through `useDbClient` — no iframe/postMessage bridge.
 *
 * Also registers a `/add-dir` slash command that drives the
 * same folder-picker → DB-update flow as the inline button,
 * so the keyboard-only path mirrors the click path. The
 * command is registered through the host's generic
 * `SlashCommandsService` (no other plugin needs to know
 * about us).
 *
 * Depends on `app` for typed access to the host's DB schema
 * and RPC surface (`slashCommands`, `dialog.pickFolder`,
 * `dialog.openInFileBrowser`, `contextMenu.show`).
 */
export default definePlugin({
  name: "contextSidebar",
  services: ["./src/main/services/*.ts"],
  dependsOn: [
    { name: "pi", from: "../pi/zenbu.plugin.ts" },{ name: "app", from: "../../zenbu.config.ts" }],
  icons: {
    // lucide: layout-grid
    "context-sidebar":
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/></svg>',
  },
});
