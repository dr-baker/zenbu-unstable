import { definePlugin } from "@zenbujs/core/config";

/**
 * Contributes an Obsidian-style inline live-preview CodeMirror
 * extension under the `cm.markdown-extension` slot, consumed by
 * every markdown editing surface (composer + MarkdownEditor).
 * Disabling the plugin drops live-preview with no host edits.
 */
export default definePlugin({
  name: "markdown",
  services: ["./src/main/services/*.ts"],
});
