import path from "node:path"
import { fileURLToPath } from "node:url"

import { Service } from "@zenbujs/core/runtime"
import { DbService } from "@zenbujs/core/services"
import {
  createEventBus,
  type EventBus,
} from "@earendil-works/pi-coding-agent"
import {
  parseRuntimeCommandsPayload,
  RUNTIME_COMMANDS_CHANNEL,
  type RuntimeCommandsPayload,
} from "../../protocol"

const here = path.dirname(fileURLToPath(import.meta.url))
const EXTENSION_DIR = path.resolve(here, "../../extension")

/**
 * Built-in extensions owned by this plugin, loaded into every embedded
 * session as ordinary path-based Pi extensions (Pi's own loader reads
 * the files; extensions get `ctx.cwd` from Pi, and talk back to zenbu
 * over the shared event bus — see `src/protocol.ts`).
 */
const BUILT_IN_EXTENSIONS = [
  {
    id: "pi:runtime-command-sync",
    file: "runtime-command-sync.ts",
    label: "Runtime command sync",
  },
  {
    id: "pi:bash-timeout",
    file: "bash-timeout.ts",
    label: "Bash timeout policy",
  },
  {
    id: "pi:zenbu-house-rules",
    file: "zenbu-house-rules.ts",
    label: "Zenbu house rules",
  },
] as const

type PiExtensionSource = "plugin" | "built-in" | "user" | "project"

export type RegisterPiExtensionArgs = {
  id: string
  path: string
  label?: string | null
  pluginName?: string | null
  enabled?: boolean
  source?: PiExtensionSource
}

export type PiSessionConfig = {
  extensionPaths: string[]
  eventBus?: EventBus
}

export type PiRuntimeApi = {
  registerExtension(args: RegisterPiExtensionArgs): Promise<{ ok: true }>
  unregisterExtension(args: { id: string }): Promise<{ ok: true }>
  getSessionConfig(args: {
    sessionId: string
    scopeId: string
    cwd: string
  }): Promise<PiSessionConfig>
  syncRuntimeCommands(args: RuntimeCommandsPayload): Promise<{ ok: true }>
  onRuntimeCommandsChanged(
    callback: (payload: RuntimeCommandsPayload) => void,
  ): () => void
}

export type { RuntimeCommandsPayload } from "../../protocol"

// Pi extension contributions are intentionally path-based. Extensions
// that need to communicate back to Zenbu should emit on the shared Pi
// event bus instead of closing over service callbacks. This keeps
// contributions serializable and visible in the Pi plugin DB/UI. If we
// find a case the event bus cannot model, revisit factory contributions
// then.
export class PiRuntimeService extends Service.create({
  key: "piRuntime",
  deps: { db: DbService },
}) implements PiRuntimeApi {
  private readonly eventBus = createEventBus()
  private readonly runtimeCommandListeners = new Set<
    (payload: RuntimeCommandsPayload) => void
  >()

  async evaluate() {
    await this.ctx.db.client.update(root => {
      for (const [id, extension] of Object.entries(root.pi.extensions)) {
        if (extension.source === "plugin" || extension.source === "built-in") {
          delete root.pi.extensions[id]
        }
      }
    })

    for (const extension of BUILT_IN_EXTENSIONS) {
      await this.registerExtension({
        id: extension.id,
        path: path.join(EXTENSION_DIR, extension.file),
        label: extension.label,
        pluginName: "pi",
        source: "built-in",
      })
    }

    this.setup("runtime-command-sync-listener", () => {
      return this.eventBus.on(RUNTIME_COMMANDS_CHANNEL, data => {
        void this.writeRuntimeCommands(data)
      })
    })
  }

  async registerExtension(args: RegisterPiExtensionArgs): Promise<{ ok: true }> {
    await this.ctx.db.client.update(root => {
      root.pi.extensions[args.id] = {
        id: args.id,
        path: args.path,
        label: args.label ?? null,
        pluginName: args.pluginName ?? null,
        enabled: args.enabled ?? true,
        source: args.source ?? "plugin",
      }
    })
    return { ok: true }
  }

  async unregisterExtension(args: { id: string }): Promise<{ ok: true }> {
    await this.ctx.db.client.update(root => {
      delete root.pi.extensions[args.id]
    })
    return { ok: true }
  }

  async getSessionConfig(_args: {
    sessionId: string
    scopeId: string
    cwd: string
  }): Promise<PiSessionConfig> {
    const extensionPaths = Object.values(
      this.ctx.db.client.readRoot().pi.extensions ?? {},
    )
      .filter(extension => extension.enabled)
      .map(extension => extension.path)

    return { extensionPaths, eventBus: this.eventBus }
  }

  async syncRuntimeCommands(args: RuntimeCommandsPayload): Promise<{ ok: true }> {
    await this.writeRuntimeCommands(args)
    return { ok: true }
  }

  onRuntimeCommandsChanged(
    callback: (payload: RuntimeCommandsPayload) => void,
  ): () => void {
    this.runtimeCommandListeners.add(callback)
    return () => {
      this.runtimeCommandListeners.delete(callback)
    }
  }

  private async writeRuntimeCommands(data: unknown): Promise<void> {
    const payload = parseRuntimeCommandsPayload(data)
    if (!payload) return
    await this.ctx.db.client.update(root => {
      for (const [id, command] of Object.entries(root.pi.runtimeCommands)) {
        if (command.sessionId === payload.sessionId) delete root.pi.runtimeCommands[id]
      }
      for (const [index, command] of payload.commands.entries()) {
        const id = `${payload.sessionId}:${command.source}:${command.name}:${index}`
        root.pi.runtimeCommands[id] = {
          id,
          sessionId: payload.sessionId,
          name: command.name,
          description: command.description,
          source: command.source,
          sourceInfo: command.sourceInfo,
        }
      }
    })
    for (const listener of this.runtimeCommandListeners) listener(payload)
  }
}
