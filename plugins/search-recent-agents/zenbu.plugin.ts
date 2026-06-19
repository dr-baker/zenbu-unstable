import { definePlugin } from "@zenbujs/core/config"

export default definePlugin({
  name: "searchRecentAgents",
  services: ["./src/main/services/*.ts"],
  dependsOn: [
    { name: "pi", from: "../pi/zenbu.plugin.ts" },{ name: "app", from: "../../zenbu.config.ts" }],
})
