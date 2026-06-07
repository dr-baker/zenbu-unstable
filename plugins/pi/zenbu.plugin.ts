import { definePlugin } from "@zenbujs/core/config"

/**
 * Pi plugin.
 *
 * Owns Pi runtime configuration and Pi-specific interoperability
 * state. The app plugin still owns live AgentSession lifecycle for
 * now, but asks this plugin for per-session Pi resource config through
 * the soft `ctx.piRuntime` service seam.
 */
export default definePlugin({
  name: "pi",
  services: ["./src/main/services/*.ts"],
  schema: "./src/main/schema.ts",
  migrations: "./migrations",
})
