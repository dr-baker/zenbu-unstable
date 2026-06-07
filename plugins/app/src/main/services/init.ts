import os from "node:os"
import { Service } from "@zenbujs/core/runtime"
import { DbService, WindowService } from "@zenbujs/core/services"
import { skeletonRouteForActiveView } from "../../shared/boot-skeleton"
import type { Schema } from "../schema"
import { buildContextMenuPrepend } from "../lib/context-menu-prepend"
import { PlaygroundService } from "./playground"

function initialSkeletonRoute(root: { app: Pick<Schema, "windowStates"> }): string {
  return skeletonRouteForActiveView(root.app.windowStates.main?.activeView)
}

export class InitService extends Service.create({
  key: "init",
  // `playground` dep is for ordering: it must seed
  // `windowStates.main.activeView` before we read it for the
  // boot skeleton route. We never call `this.ctx.playground`.
  deps: { window: WindowService, db: DbService, playground: PlaygroundService },
}) {
  async evaluate() {
    // Stamp the user's home dir into replicated state so the
    // renderer can collapse absolute paths to `~/...` without a
    // per-render RPC round-trip.
    const homeDir = os.homedir()
    await this.ctx.db.client.update(root => {
      if (root.app.env.homeDir !== homeDir) {
        root.app.env.homeDir = homeDir
      }
    })

    const root = this.ctx.db.client.readRoot()

    await this.ctx.window.openWindow({
      query: { skeletonRoute: initialSkeletonRoute(root) },
      baseWindow: {
        // Smaller default window for the onboarding-focused first launch.
        width: 760,
        height: 540,
        minWidth: 430,
        minHeight: 310,
        trafficLightPosition: { x: 14, y: 9 },
      },
      contextMenu: { prepend: buildContextMenuPrepend() },
    })
  }
}
