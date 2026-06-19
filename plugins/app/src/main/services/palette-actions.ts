import { Service } from "@zenbujs/core/runtime"
import { DbService } from "@zenbujs/core/services"

export type PaletteActionRpcRef = {
  /** Plugin name that owns the service (e.g. `"app"`, `"plan"`). */
  plugin: string
  /** Service key as declared on the service class (e.g. `"shortcuts"`). */
  service: string
  /** Public method name on that service. */
  method: string
}

export type RegisteredPaletteAction = {
  id: string
  label: string
  hint?: string | null
  /** Optional grouping label. Not yet rendered, but persisted so a
   * future grouped palette can light up without a schema change. */
  group?: string | null
  rpc: PaletteActionRpcRef
  /** Extra args merged into the dispatch call. Lets one RPC method
   * back multiple palette rows (e.g. `focusPane` + `{ index: N }`
   * for Cmd+1…9). The renderer always also passes `{ windowId }`. */
  args?: Record<string, unknown> | null
}

/**
 * Generic registry of command-palette actions contributed by zenbu
 * plugins (including the host itself).
 *
 * Mirrors the shape of `SlashCommandsService`: any plugin can
 * register an action from within its own service `setup()` block,
 * supplying an RPC location that the renderer should dispatch when
 * the user picks the action. The handler runs in the main process
 * and is free to do anything (mutate the db, emit events, call
 * other services, register more state, …) — that's where the power
 * comes from.
 *
 * Lifecycle:
 *  - `evaluate()` wipes `root.app.paletteActions` on every service
 *    start. Plugin services depend on this service (string-keyed or
 *    class-keyed), so they run after; their `setup()` blocks call
 *    `register()` and pair it with `unregister()` in the cleanup.
 *    The DB record is therefore always a faithful reflection of
 *    what's currently installed.
 *  - The renderer subscribes via `useDb(root => root.app.paletteActions)`
 *    so additions / removals appear in the palette without any
 *    extra plumbing.
 *
 * Dispatch contract:
 *  - The renderer always invokes the handler with a single object
 *    `{ windowId: string }` so per-window context is available.
 *    Handlers that need more context should derive it from the
 *    DB (which is keyed by `windowId` for most chrome state).
 *  - Return values are ignored (fire-and-forget). For multi-step
 *    UX, the handler should emit an event or mutate the DB to
 *    surface the next screen.
 */
export class PaletteActionsService extends Service.create({
  key: "paletteActions",
  deps: { db: DbService },
}) {
  async evaluate() {
    // Wipe stale entries from the previous process. Plugins that
    // depend on us re-register from their own evaluate() / setup().
    await this.ctx.db.client.update((root) => {
      root.app.paletteActions = {}
    })
  }

  async register(spec: RegisteredPaletteAction): Promise<{ ok: true }> {
    await this.ctx.db.client.update((root) => {
      root.app.paletteActions[spec.id] = {
        id: spec.id,
        label: spec.label,
        hint: spec.hint ?? null,
        group: spec.group ?? null,
        rpc: {
          plugin: spec.rpc.plugin,
          service: spec.rpc.service,
          method: spec.rpc.method,
        },
        args: spec.args ?? null,
      }
    })
    return { ok: true }
  }

  async unregister(args: { id: string }): Promise<{ ok: true }> {
    await this.ctx.db.client.update((root) => {
      delete root.app.paletteActions[args.id]
    })
    return { ok: true }
  }

  /** Snapshot of every currently-registered action. Mostly useful
   * for diagnostics / debugging — production callers should read
   * `root.app.paletteActions` directly. */
  list(): RegisteredPaletteAction[] {
    return Object.values(
      this.ctx.db.client.readRoot().app.paletteActions ?? {},
    )
  }
}
