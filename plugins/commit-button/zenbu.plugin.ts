import { definePlugin } from "@zenbujs/core/config"

/**
 * Commit-button plugin.
 *
 * Contributes the title-bar commit button: the small `+a −b` badge
 * that surfaces the active scope's working-tree diff size and opens
 * a commit / pull-request popover on click. Previously baked into
 * `plugins/app`'s `WorkspaceTitleBar`; pulled out here so the
 * commit surface is owned by its own plugin.
 *
 * It carries no schema / events / DB of its own — all the data and
 * mutations come from the host's git + github services
 * (`rpc.app.git.*`, `rpc.app.github.*`), so it just `dependsOn`
 * `app` and injects a single `title-bar` component view.
 */
export default definePlugin({
  name: "commitButton",
  services: ["./src/main/services/*.ts"],
  dependsOn: [{ name: "app", from: "../../zenbu.config.ts" }],
})
