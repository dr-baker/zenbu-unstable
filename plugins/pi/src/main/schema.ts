import { createSchema, z } from "@zenbujs/core/db"

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

export default createSchema({
  extensions: z.record(z.string(), extension).default({}),
  runtimeCommands: z.record(z.string(), runtimeCommand).default({}),
})
