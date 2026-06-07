import { Service } from "@zenbujs/core/runtime"
import { DbService } from "@zenbujs/core/services"

import type { PiRuntimeApi } from "../../../pi/src/main/services/pi-runtime"

type RuntimeCommand = {
  id: string
  sessionId: string
  name: string
  description?: string | null
  source: "extension" | "prompt" | "skill"
  sourceInfo?: unknown
}

type SlashRegistry = {
  register(spec: {
    id: string
    name: string
    label: string
    description?: string | null
    hint?: string | null
    group?: string | null
    source?: string | null
    rpc: { plugin: string; service: string; method: string }
  }): Promise<{ ok: true }>
  unregister(args: { id: string }): Promise<{ ok: true }>
}

type SessionsApi = {
  runRuntimeCommand(args: { sessionId: string; text: string }): Promise<unknown>
}

type SourceInfoLike = {
  source?: string
  scope?: string
  origin?: string
}

/**
 * Composer integration for Pi's runtime-discovered slash commands.
 *
 * `root.pi.runtimeCommands` remains the source of truth. This service mirrors
 * the currently-known command names into the app's generic slash-command
 * registry so the host composer can render them through the stable registry
 * path, then dispatches selection/typed invocation back to the live Pi session.
 */
export class PiAutoCommandsService extends Service.create({
  key: "piAutoCommands",
  deps: {
    db: DbService,
    slashCommands: "slashCommands",
    sessions: "sessions",
    piRuntime: "piRuntime",
  },
}) {
  private readonly registeredIds = new Set<string>()

  evaluate() {
    this.setup("register-runtime-slash-commands", () => {
      let disposed = false
      const sync = () => {
        if (!disposed) void this.syncSlashCommands()
      }
      sync()
      const unsubscribe = (this.ctx.piRuntime as PiRuntimeApi)
        .onRuntimeCommandsChanged(sync)
      return () => {
        disposed = true
        unsubscribe()
        for (const id of this.registeredIds) {
          void (this.ctx.slashCommands as SlashRegistry).unregister({ id })
        }
        this.registeredIds.clear()
      }
    })
  }

  async runRuntimeCommand(args: {
    sessionId?: string | null
    command: string
    text?: string
    argsText?: string
  }): Promise<{ kind: "none" }> {
    if (!args.sessionId) throw new Error("No active session")
    const suffix = args.argsText ? ` ${args.argsText}` : ""
    const text = args.text?.trim() || `/${args.command}${suffix}`
    await (this.ctx.sessions as SessionsApi).runRuntimeCommand({
      sessionId: args.sessionId,
      text,
    })
    return { kind: "none" }
  }

  private async syncSlashCommands(): Promise<void> {
    const registry = this.ctx.slashCommands as SlashRegistry
    const commands = Object.values(
      this.ctx.db.client.readRoot().pi.runtimeCommands ?? {},
    ) as RuntimeCommand[]

    const byName = new Map<string, RuntimeCommand>()
    for (const command of commands.sort(compareRuntimeCommands)) {
      if (!byName.has(command.name)) byName.set(command.name, command)
    }

    const nextIds = new Set<string>()
    for (const command of byName.values()) {
      const id = commandId(command.name)
      nextIds.add(id)
      await registry.register({
        id,
        name: command.name,
        label: command.name,
        description: command.description ?? null,
        group: groupForSource(command.source),
        hint: hintForCommand(command),
        source: "Pi Runtime",
        rpc: {
          plugin: "piAutoCommands",
          service: "piAutoCommands",
          method: "runRuntimeCommand",
        },
      })
    }

    for (const id of [...this.registeredIds]) {
      if (nextIds.has(id)) continue
      await registry.unregister({ id })
      this.registeredIds.delete(id)
    }
    for (const id of nextIds) this.registeredIds.add(id)
  }
}

function commandId(name: string): string {
  return `pi-runtime:${encodeURIComponent(name)}`
}

function compareRuntimeCommands(a: RuntimeCommand, b: RuntimeCommand): number {
  const source = sourceRank(a.source) - sourceRank(b.source)
  return source || a.name.localeCompare(b.name)
}

function sourceRank(source: RuntimeCommand["source"]): number {
  switch (source) {
    case "extension":
      return 0
    case "prompt":
      return 1
    case "skill":
      return 2
  }
}

function groupForSource(source: RuntimeCommand["source"]): string {
  switch (source) {
    case "extension":
      return "Pi Extensions"
    case "prompt":
      return "Pi Prompts"
    case "skill":
      return "Pi Skills"
  }
}

function hintForCommand(command: RuntimeCommand): string {
  const info = asSourceInfo(command.sourceInfo)
  const kind = command.source === "extension" ? "extension" : command.source
  const provenance = info?.origin === "package"
    ? "package"
    : info?.scope ?? info?.source ?? null
  return provenance ? `${kind} · ${provenance}` : kind
}

function asSourceInfo(value: unknown): SourceInfoLike | null {
  if (!value || typeof value !== "object") return null
  return value as SourceInfoLike
}
