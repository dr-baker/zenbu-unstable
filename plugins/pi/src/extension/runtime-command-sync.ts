import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent"
import {
  RUNTIME_COMMANDS_CHANNEL,
  type RuntimeCommandsPayload,
} from "../protocol"

export default function runtimeCommandSync(pi: ExtensionAPI) {
  const sync = (_event: unknown, ctx: ExtensionContext) => {
    pi.events.emit(RUNTIME_COMMANDS_CHANNEL, {
      sessionId: ctx.sessionManager.getSessionId(),
      commands: pi.getCommands(),
    } satisfies RuntimeCommandsPayload)
  }

  pi.on("session_start", sync)
  pi.on("resources_discover", sync)
}
