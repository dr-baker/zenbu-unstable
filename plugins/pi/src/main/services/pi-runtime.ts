import path from "node:path"
import { fileURLToPath } from "node:url"

import { Service } from "@zenbujs/core/runtime"
import { DbService } from "@zenbujs/core/services"
import {
  createEventBus,
  type EventBus,
  type SlashCommandInfo,
} from "@earendil-works/pi-coding-agent"

const RUNTIME_COMMANDS_CHANNEL = "zenbu-pi:runtime-commands"

const here = path.dirname(fileURLToPath(import.meta.url))
const RUNTIME_COMMAND_SYNC_EXTENSION_PATH = path.resolve(
  here,
  "../../extension/runtime-command-sync.ts",
)

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

export type RuntimeCommandsPayload = {
  sessionId: string
  commands: SlashCommandInfo[]
}

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

    await this.registerExtension({
      id: "pi:runtime-command-sync",
      path: RUNTIME_COMMAND_SYNC_EXTENSION_PATH,
      label: "Runtime command sync",
      pluginName: "pi",
      source: "built-in",
    })

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
    if (!isRuntimeCommandsPayload(data)) return
    await this.ctx.db.client.update(root => {
      for (const [id, command] of Object.entries(root.pi.runtimeCommands)) {
        if (command.sessionId === data.sessionId) delete root.pi.runtimeCommands[id]
      }
      for (const [index, command] of data.commands.entries()) {
        const id = `${data.sessionId}:${command.source}:${command.name}:${index}`
        root.pi.runtimeCommands[id] = {
          id,
          sessionId: data.sessionId,
          name: command.name,
          description: command.description,
          source: command.source,
          sourceInfo: command.sourceInfo,
        }
      }
    })
    for (const listener of this.runtimeCommandListeners) listener(data)
  }
}

function isRuntimeCommandsPayload(data: unknown): data is RuntimeCommandsPayload {
  if (!data || typeof data !== "object") return false
  const payload = data as Partial<RuntimeCommandsPayload>
  return (
    typeof payload.sessionId === "string" &&
    Array.isArray(payload.commands) &&
    payload.commands.every(command => {
      if (!command || typeof command !== "object") return false
      const c = command as Partial<SlashCommandInfo>
      return (
        typeof c.name === "string" &&
        (c.description === undefined || typeof c.description === "string") &&
        (c.source === "extension" || c.source === "prompt" || c.source === "skill")
      )
    })
  )
}
