import os from "node:os"

import {
  createAgentSessionServices,
  type AuthStorage,
  type ModelRegistry,
} from "@earendil-works/pi-coding-agent"

/**
 * Load Pi packages from `~/.pi/agent/settings.json` and flush any
 * extension-queued `registerProvider` calls into the shared registry.
 *
 * Terminal Pi does this via `createAgentSessionServices()` before the
 * model picker reads `getAvailable()`. Zenbu must do the same at boot
 * so package-contributed providers (e.g. `pi-cursor-sdk`) appear in
 * `root.pi.models` without waiting for the first chat activation.
 */
export async function preloadPackageProviders(args: {
  authStorage: AuthStorage
  modelRegistry: ModelRegistry
  cwd?: string
}): Promise<void> {
  const { diagnostics } = await createAgentSessionServices({
    cwd: args.cwd ?? os.homedir(),
    authStorage: args.authStorage,
    modelRegistry: args.modelRegistry,
  })

  for (const diagnostic of diagnostics) {
    const message =
      typeof diagnostic.message === "string"
        ? diagnostic.message
        : String(diagnostic.message)
    if (diagnostic.type === "error") {
      console.error("[pi] package preload:", message)
    } else {
      console.warn("[pi] package preload:", message)
    }
  }
}
