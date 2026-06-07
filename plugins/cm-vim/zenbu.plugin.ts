import { definePlugin } from "@zenbujs/core/config";

/**
 * cm-vim plugin.
 *
 * Owns everything vim-related in the renderer:
 *
 *  1. **Extension contribution** — a bootstrap injection mounts a
 *     tiny React root that reads `db.app.settings.vimMode` and uses
 *     `useRegisterInjection(...)` to register/unregister the vim
 *     CodeMirror extension under
 *     `meta.kind = "cm.composer-extension-editable"`. The host
 *     composer reads the injection registry and reconfigures its
 *     compartment when the registry changes — so toggling the
 *     setting flips vim on/off without restarting the editor.
 *
 *  2. **Mode store** — the registered extension also installs a
 *     `ViewPlugin` that subscribes to `vim-mode-change` and publishes
 *     the current mode to a renderer-side singleton (this plugin's
 *     `./store` entry). The status-bar item reads from the store.
 *
 *  3. **Status-bar item** — the same bootstrap injection registers
 *     `VimModeStatusItem` under `meta.kind = "footer.item"` with
 *     `position: "right"`. The host's footer slot picks it up via
 *     the injection registry and renders it on the right side of
 *     the chat-pane footer; clicking toggles vim mode. Reads the
 *     store + the db setting directly; no host surface area for
 *     it to depend on.
 *
 * Depends on `app` for typed access to the host's `db.app.settings`
 * (for the vim-mode toggle).
 */
export default definePlugin({
  name: "vim",
  services: ["./src/main/services/*.ts"],
  dependsOn: [{ name: "app", from: "../../zenbu.config.ts" }],
});
