import { definePlugin } from "@zenbujs/core/config"

/**
 * Pi plugin.
 *
 * Owns the Pi runtime end to end: live AgentSession lifecycle
 * (sessions, queue, branching, event log), Pi auth + the model
 * registry, extension contributions (path-based, see src/protocol.ts),
 * and runtime command discovery. The app plugin is the shell; chat
 * tab/draft state stays there with the chat surface.
 */

const SVG_PREFIX =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
const SVG_SUFFIX = "</svg>"
const lucide = (body: string) => `${SVG_PREFIX}${body}${SVG_SUFFIX}`

// lucide: logs — the pi-event-log sidebar view.
const LOGS =
  '<path d="M3 5h1"/><path d="M3 12h1"/><path d="M3 19h1"/><path d="M8 5h1"/><path d="M8 12h1"/><path d="M8 19h1"/><path d="M13 5h8"/><path d="M13 12h8"/><path d="M13 19h8"/>'

// lucide: boxes — the Pi resources/capabilities sidebar view.
const RESOURCES =
  '<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>'

export default definePlugin({
  name: "pi",
  // Keep this explicit so helper/test modules under services/ are not evaluated
  // as runtime services. Loading `*.test.ts` at app boot pulls in Vitest and
  // crashes outside the test runner.
  services: [
    "./src/main/services/auth.ts",
    "./src/main/services/pi-event-log.ts",
    "./src/main/services/pi-resource-registry.ts",
    "./src/main/services/pi-resource-state-view.ts",
    "./src/main/services/pi-runtime.ts",
    "./src/main/services/session-activity.ts",
    "./src/main/services/sessions.ts",
  ],
  schema: "./src/main/schema/index.ts",
  events: "./src/main/events.ts",
  migrations: "./migrations",
  // Type-only: the pi-event-log view reads `root.pi.sessions`.
  dependsOn: [{ name: "app", from: "../../zenbu.config.ts" }],
  icons: {
    "pi-event-log": lucide(LOGS),
    "pi-resource-state": lucide(RESOURCES),
  },
})
