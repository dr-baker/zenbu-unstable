import { definePlugin } from "@zenbujs/core/config"

/**
 * Skill Pills plugin.
 *
 * Adds a visual-only CodeMirror extension to the composer so read-only
 * user-message bubbles that contain loaded Pi skill instructions collapse to
 * a small pill instead of rendering the entire skill body in chat history.
 */
export default definePlugin({
  name: "skillPills",
  services: ["./src/main/services/*.ts"],
  dependsOn: [
    { name: "app", from: "../../zenbu.config.ts" },
    // Reads `root.pi.runtimeCommands` to learn skill/prompt command names.
    { name: "pi", from: "../pi/zenbu.plugin.ts" },
  ],
})
