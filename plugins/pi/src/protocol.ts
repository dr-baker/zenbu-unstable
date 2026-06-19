import { z } from "zod"
import type { SlashCommandInfo } from "@earendil-works/pi-coding-agent"

/**
 * Shared protocol for the zenbu ↔ Pi-extension event bus.
 *
 * Pi extension contributions are path-based files loaded by Pi's own
 * resource loader; the sanctioned back-channel into zenbu is the shared
 * event bus the pi plugin passes to `DefaultResourceLoader`. Channel
 * names and payload shapes live here — imported by BOTH sides (the
 * `PiRuntimeService` listener and the extension emitters) — so the
 * contract can't silently drift the way per-side hand-rolled guards
 * did.
 *
 * Add a constant + schema pair per channel. Extensions contributed by
 * other plugins should follow the same pattern for their own channels
 * (in their own plugin; this module only defines pi-owned channels).
 */

export const RUNTIME_COMMANDS_CHANNEL = "zenbu-pi:runtime-commands"

const runtimeCommandsPayloadSchema = z.object({
  sessionId: z.string(),
  commands: z.array(
    z
      .object({
        name: z.string(),
        description: z.string().optional(),
        source: z.enum(["extension", "prompt", "skill"]),
        sourceInfo: z.unknown().optional(),
      })
      // Pi may grow SlashCommandInfo; don't reject newer fields.
      .loose(),
  ),
})

export type RuntimeCommandsPayload = {
  sessionId: string
  commands: SlashCommandInfo[]
}

export function parseRuntimeCommandsPayload(
  data: unknown,
): RuntimeCommandsPayload | null {
  const result = runtimeCommandsPayloadSchema.safeParse(data)
  return result.success ? (result.data as RuntimeCommandsPayload) : null
}
