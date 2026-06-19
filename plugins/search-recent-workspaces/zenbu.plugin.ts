import { definePlugin } from "@zenbujs/core/config"

/**
 * Recent Workspaces palette.
 *
 * Cmd+O (mod+O) pops a VS Code Cmd+P-flavored picker listing every
 * workspace, sorted by the last time it was active in any window.
 * Enter swaps to the previously-active workspace (rows[0] is the
 * currently active workspace, so the cursor defaults to row 1).
 *
 * The service subscribes to `app.windowStates` and stamps its own
 * `lastVisitedAt[workspaceId]` whenever a window transitions to a
 * new active workspace. That keeps the recency record independent
 * of any host-side timestamps and survives across boots.
 */
export default definePlugin({
  name: "searchRecentWorkspaces",
  services: ["./src/main/services/*.ts"],
  schema: "./src/main/schema.ts",
  events: "./src/main/events.ts",
  migrations: "./migrations",
  dependsOn: [
    { name: "pi", from: "../pi/zenbu.plugin.ts" },{ name: "app", from: "../../zenbu.config.ts" }],
})
