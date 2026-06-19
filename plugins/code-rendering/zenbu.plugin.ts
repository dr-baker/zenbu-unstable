import { definePlugin } from "@zenbujs/core/config"

/**
 * Code Rendering plugin.
 *
 * Keeps the host chat markdown pipeline intact, but wraps assistant and
 * thinking messages with a small CSS scope that flattens Streamdown's code
 * block chrome. This lets the plugin change only code rendering while prose,
 * lists, links, tables, and tool cards continue to use the host defaults.
 */
export default definePlugin({
  name: "codeRendering",
  services: ["./src/main/services/*.ts"],
  dependsOn: [{ name: "app", from: "../../zenbu.config.ts" }],
})
