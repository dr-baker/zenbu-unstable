import { createSchema, z } from "@zenbujs/core/db"
import type { InferSchemaRoot } from "@zenbujs/core/db"

import { session, killedSession, reloadToast, modelInfo } from "./session"
import { providerStatus, oauthFlow } from "./auth"

const piExtensionSource = z.enum(["plugin", "built-in", "user", "project"])

const extension = z.object({
  id: z.string(),
  path: z.string(),
  label: z.string().nullable().default(null),
  pluginName: z.string().nullable().default(null),
  enabled: z.boolean().default(true),
  source: piExtensionSource.default("plugin"),
})

const runtimeCommandSource = z.enum(["extension", "prompt", "skill"])

const runtimeCommand = z.object({
  id: z.string(),
  sessionId: z.string(),
  name: z.string(),
  description: z.string().optional(),
  source: runtimeCommandSource,
  sourceInfo: z.unknown(),
})

const schema = createSchema({
  extensions: z.record(z.string(), extension).default({}),
  runtimeCommands: z.record(z.string(), runtimeCommand).default({}),

  /** One agent conversation backed by a pi session file. Owned by
   * `SessionsService`; the chat surface holds only a sessionId ref. */
  sessions: z.record(z.string(), session).default({}),
  /** Sessions whose in-flight agent run was killed by a hot reload
   * or shutdown. Surfaced as a Continue/Dismiss toast. */
  killedSessions: z.record(z.string(), killedSession).default({}),
  /** Renderer-consumed signal: session id → auto-resume timestamp,
   * written when main silently resumes after a hot reload. */
  pendingReloadToasts: z.record(z.string(), reloadToast).default({}),
  /** Pi's model catalog, published by `AuthService`. */
  models: z.record(z.string(), modelInfo).default({}),
  /** Snapshot of every provider's auth status. Rebuilt on every
   * boot and after every auth mutation by `AuthService`. No
   * secrets — values come from `AuthStorage.getAuthStatus()`. */
  providerStatuses: z.record(z.string(), providerStatus).default({}),
  /** Currently-running OAuth login flow, or `null` when idle. At
   * most one flow at a time — starting a second `/login` aborts
   * the first. */
  oauthFlow: oauthFlow.nullable().default(null),
})

export default schema
export type Schema = InferSchemaRoot<typeof schema>
