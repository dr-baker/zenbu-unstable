import { definePlugin } from "@zenbujs/core/config"

/**
 * Recent Worktrees palette.
 *
 * Cmd+; (mod+semicolon) pops a focused fuzzy picker listing the
 * active workspace's worktrees, sorted by the most recently
 * opened chat inside each worktree.
 *
 * No new state: recency is derived purely from existing host
 * timestamps (`session.lastOpenedAt`, the same field
 * `searchRecentAgents` rides on). Selecting a worktree is a
 * proxy for selecting its most-recently-opened chat — same
 * code path as clicking the chat in the agent sidebar — so the
 * picker is intentionally "agent-recent grouped by worktree".
 */
export default definePlugin({
  name: "searchRecentWorktrees",
  services: ["./src/main/services/*.ts"],
  events: "./src/main/events.ts",
  dependsOn: [
    { name: "pi", from: "../pi/zenbu.plugin.ts" },{ name: "app", from: "../../zenbu.config.ts" }],
})
