import { definePlugin } from "@zenbujs/core/config"

/**
 * Core Pi command plugin.
 *
 * Registers Pi-compatible slash commands through the host's generic
 * SlashCommandsService and installs one tiny Composer advice to prove
 * the input surface can be extended by plugins via CodeMirror
 * extensions, not just by editing the host component.
 */
export default definePlugin({
  name: "piCommands",
  services: ["./src/main/services/*.ts"],
  schema: "./src/main/schema.ts",
  migrations: "./migrations",
  dependsOn: [
    { name: "pi", from: "../pi/zenbu.plugin.ts" },
    { name: "app", from: "../../zenbu.config.ts" },
    { name: "settings", from: "../../zenbu.config.ts" },
  ],
})
