import { definePlugin } from "@zenbujs/core/config";

/**
 * cm-image-paste plugin.
 *
 * Listens for paste events with image payloads inside the host
 * composer, persists the bytes via `createBlob`, populates the
 * renderer-local image cache, and inserts the `@blob:<id>` pill
 * token at the caret in the same transaction so undo/redo is one
 * step.
 *
 * Owns a single content script that:
 *
 *   1. Reads `useDbClient()` and stashes it in a module-level ref so
 *      the CodeMirror paste handler (which runs outside React) can
 *      reach it.
 *
 *   2. Registers the paste CodeMirror extension under
 *      `meta.kind = "cm.composer-extension"`. The host composer
 *      reads the registry directly and merges the extension into
 *      its compartment.
 *
 * Depends on `app` for the shared image-cache module.
 */
export default definePlugin({
  name: "imagePaste",
  services: ["./src/main/services/*.ts"],
  dependsOn: [{ name: "app", from: "../../zenbu.config.ts" }],
});
