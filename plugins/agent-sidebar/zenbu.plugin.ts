import { definePlugin } from "@zenbujs/core/config";

/**
 * Agent left-sidebar plugin.
 *
 * Owns the chat list — the default left-sidebar tab. Registers a
 * `rendering: "component"` view of type `"agent"` tagged
 * `meta.kind = "left-sidebar"`, so the host's
 * `LeftSidebarTabBar` lists it alongside other plugin-contributed
 * tabs.
 *
 * The view itself is a thin React component that pulls together
 * the chat list, worktree groups, split-button header, and the
 * sidebar footer. It runs in-process inside the host renderer
 * realm — component views share the host tree, so the plugin can
 * reach into the host's shared selectors, RPC, and DB types
 * directly via the `@/` alias (configured in this plugin's
 * `tsconfig.json` and resolved at runtime by the host's Vite
 * server).
 *
 * Depends on `app` for typed access to the host's schema and RPC.
 */
export default definePlugin({
  name: "agentSidebar",
  services: ["./src/main/services/*.ts"],
  schema: "./src/main/schema.ts",
  migrations: "./migrations",
  events: "./src/main/events.ts",
  dependsOn: [
    { name: "pi", from: "../pi/zenbu.plugin.ts" },{ name: "app", from: "../../zenbu.config.ts" }],
  icons: {
    // lucide: message-square — matches the chat-bubble glyph used
    // elsewhere in the app for "a chat".
    agent:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z"/></svg>',
  },
});
