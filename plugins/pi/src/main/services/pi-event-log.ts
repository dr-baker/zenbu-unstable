import { Service } from "@zenbujs/core/runtime"

/**
 * Registers the `"pi-event-log"` sidebar view. The view module is
 * served through the host renderer's vite server (so it shares
 * tailwind / theme vars) and reads `session.eventLog` directly from
 * the DB, so events stream in live without any extra RPC.
 */
export class PiEventLogService extends Service.create({
  key: "piEventLog",
}) {
  evaluate() {
    this.setup("register-view", () =>
      this.inject({
        name: "pi-event-log",
        modulePath: "src/views/pi-event-log-app.tsx",
        exportName: "PiEventLogApp",
        meta: { kind: "view", label: "Pi Events" },
      }),
    )
  }
}
