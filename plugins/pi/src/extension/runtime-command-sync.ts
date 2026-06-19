import type {
  ExtensionAPI,
  ExtensionContext,
  SlashCommandInfo,
} from "@earendil-works/pi-coding-agent"

const CHANNEL = "zenbu-pi:runtime-commands"

export default function runtimeCommandSync(pi: ExtensionAPI) {
  const sync = (_event: unknown, ctx: ExtensionContext) => {
    pi.events.emit(CHANNEL, {
      sessionId: ctx.sessionManager.getSessionId(),
      commands: pi.getCommands(),
    } satisfies RuntimeCommandsPayload)
  }

  pi.on("session_start", sync)
  pi.on("resources_discover", sync)
}

type RuntimeCommandsPayload = {
  sessionId: string
  commands: SlashCommandInfo[]
}
