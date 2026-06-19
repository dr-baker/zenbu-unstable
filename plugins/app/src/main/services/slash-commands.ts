import { Service } from "@zenbujs/core/runtime"
import { DbService } from "@zenbujs/core/services"

export type SlashCommandRpcRef = {
  /** Plugin name that owns the service (e.g. `"app"`, `"piCommands"`). */
  plugin: string
  /** Service key as declared on the service class. */
  service: string
  /** Public method name on that service. */
  method: string
}

export type RegisteredSlashCommand = {
  id: string
  /** Invoked as `/${name}`. No leading slash. */
  name: string
  label: string
  description?: string | null
  hint?: string | null
  group?: string | null
  source?: string | null
  rpc: SlashCommandRpcRef
  /** Extra args merged into the dispatch call. */
  args?: Record<string, unknown> | null
  /** Selecting the typeahead row inserts `/${name} ` instead of
   * dispatching immediately. Typed Enter still dispatches. */
  insertOnSelect?: boolean
}

/**
 * Generic slash-command registry for chat/composer commands.
 *
 * This is intentionally the same shape as `PaletteActionsService`:
 * plugins register lightweight command metadata plus an RPC location;
 * the renderer owns typeahead / typed slash parsing and dynamically
 * dispatches the registered RPC with chat context.
 */
export class SlashCommandsService extends Service.create({
  key: "slashCommands",
  deps: { db: DbService },
}) {
  async evaluate() {
    await this.ctx.db.client.update(root => {
      root.app.slashCommands = {}
    })
  }

  async register(spec: RegisteredSlashCommand): Promise<{ ok: true }> {
    const next = normalizeSlashCommand(spec)
    await this.ctx.db.client.update(root => {
      const existing = root.app.slashCommands[spec.id]
      if (existing && slashCommandsEqual(existing, next)) return
      root.app.slashCommands[spec.id] = next
    })
    return { ok: true }
  }

  async unregister(args: { id: string }): Promise<{ ok: true }> {
    await this.ctx.db.client.update(root => {
      if (!root.app.slashCommands[args.id]) return
      delete root.app.slashCommands[args.id]
    })
    return { ok: true }
  }

  list(): RegisteredSlashCommand[] {
    return Object.values(this.ctx.db.client.readRoot().app.slashCommands ?? {})
  }
}

type StoredSlashCommand = RegisteredSlashCommand & {
  description: string | null
  hint: string | null
  group: string | null
  source: string | null
  args: Record<string, unknown> | null
  insertOnSelect: boolean
}

function normalizeSlashCommand(spec: RegisteredSlashCommand): StoredSlashCommand {
  return {
    id: spec.id,
    name: spec.name,
    label: spec.label,
    description: spec.description ?? null,
    hint: spec.hint ?? null,
    group: spec.group ?? null,
    source: spec.source ?? null,
    rpc: {
      plugin: spec.rpc.plugin,
      service: spec.rpc.service,
      method: spec.rpc.method,
    },
    args: spec.args ?? null,
    insertOnSelect: spec.insertOnSelect ?? false,
  }
}

function slashCommandsEqual(
  a: StoredSlashCommand,
  b: StoredSlashCommand,
): boolean {
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.label === b.label &&
    a.description === b.description &&
    a.hint === b.hint &&
    a.group === b.group &&
    a.source === b.source &&
    a.rpc.plugin === b.rpc.plugin &&
    a.rpc.service === b.rpc.service &&
    a.rpc.method === b.rpc.method &&
    a.insertOnSelect === b.insertOnSelect &&
    stableStringify(a.args) === stableStringify(b.args)
  )
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortJson(value))
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, sortJson(child)]),
  )
}
