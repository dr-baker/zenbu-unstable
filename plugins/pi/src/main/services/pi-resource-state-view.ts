import { Service } from "@zenbujs/core/runtime"

const NAME = "pi-resource-state"

export class PiResourceStateViewService extends Service.create({
  key: "piResourceStateView",
}) {
  evaluate() {
    this.setup("register-view", () =>
      this.inject({
        name: NAME,
        modulePath: "src/views/pi-resource-state-app.tsx",
        exportName: "PiResourceStateApp",
        meta: {
          kind: "right-sidebar",
          label: "Pi",
          order: 35,
        },
      }),
    )
  }
}
