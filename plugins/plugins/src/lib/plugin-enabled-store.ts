import { useCallback, useMemo } from "react"
import { useDb, useRpc } from "@zenbujs/core/react"

export type InstalledPluginListing = {
  name: string
  dir: string
  kind: "plugin" | "pi-extension"
  tag: "core" | "pi" | null
  enabled: boolean
  pluginFile: string | null
  description: string | null
  author: string | null
  version: string | null
}

export function useInstalledPlugins(): InstalledPluginListing[] {
  const plugins = useDb(root => root.app.plugins)
  return useMemo(
    () =>
      [...(plugins ?? [])].sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
      ),
    [plugins],
  )
}

export function useTogglePlugin(): (args: {
  pluginFile: string
  enabled: boolean
}) => void {
  const rpc = useRpc()
  return useCallback(
    args => {
      void rpc.plugins.marketplace
        .setPluginEnabled({
          pluginFile: args.pluginFile,
          enabled: args.enabled,
        })
        .catch((err: unknown) =>
          console.error("[marketplace] setPluginEnabled failed:", err),
        )
    },
    [rpc],
  )
}
