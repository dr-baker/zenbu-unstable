import { definePlugin } from "@zenbujs/core/config"

/**
 * Chat plugin.
 *
 * Owns the chat SURFACE: the chat pane (message list + composer +
 * footer strip), the CodeMirror composer stack, and the standalone
 * chat window view. The app shell renders the pane through the
 * `"chat-pane"` injection; everything else reaches this surface the
 * same way every other plugin does (advice on the composer/message
 * components, footer-item injections, slash-command registry rows).
 *
 * Deliberately NOT owned here (Phase 3 decision, see
 * plans/2026-06-11-app-plugin-decomposition.md):
 *  - `root.app.chats` / `chatStates` / `chatWindows` records stay in
 *    the app plugin — they're shell-level conversation/tab handles
 *    written by the shell (workspaces), the sidebar, and pi's
 *    branching flows. This plugin writes `root.app.chatStates`
 *    drafts directly: a deliberate, documented exception to the
 *    "never write another plugin's section" convention, revisited
 *    when drafts get a real owner seam.
 *  - Session state is the pi plugin's (`root.pi.sessions`,
 *    `rpc.pi.sessions`).
 */
export default definePlugin({
  name: "chat",
  services: ["./src/main/services/*.ts"],
  dependsOn: [
    { name: "app", from: "../../zenbu.config.ts" },
    { name: "pi", from: "../pi/zenbu.plugin.ts" },
  ],
})
