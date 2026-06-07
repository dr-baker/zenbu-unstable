import { definePlugin } from "@zenbujs/core/config"

/**
 * Pi Automatic Commands plugin.
 *
 * UX layer for runtime slash commands discovered by the core Pi plugin.
 * The command catalog stays in `root.pi.runtimeCommands`; this plugin
 * only projects those rows into the host composer typeahead and dispatches
 * selected commands through the app's narrow live-session runtime seam.
 */
export default definePlugin({
  name: "piAutoCommands",
  services: ["./src/main/services/*.ts"],
  dependsOn: [
    { name: "app", from: "../../zenbu.config.ts" },
    { name: "pi", from: "../pi/zenbu.plugin.ts" },
  ],
})
