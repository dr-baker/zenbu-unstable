import { Service } from "@zenbujs/core/runtime"
import { DbService } from "@zenbujs/core/services"

const SECTION_ID = "marketplace"
const ITEM_ID = "marketplace.enabled"

type SettingsRegistry = {
  registerSection: (spec: unknown) => Promise<unknown>
  unregisterSection: (a: { id: string }) => Promise<unknown>
  registerItem: (spec: unknown) => Promise<unknown>
  unregisterItem: (a: { id: string }) => Promise<unknown>
  setValue: (a: {
    id: string
    value: string | number | boolean
  }) => Promise<unknown>
}

export class MarketplaceSettingsService extends Service.create({
  key: "marketplaceSettings",
  deps: {
    settingsRegistry: "settingsRegistry",
    db: DbService,
  },
}) {
  evaluate() {
    this.setup("register-section", () => {
      const reg = this.ctx.settingsRegistry as SettingsRegistry

      void reg.registerSection({
        id: SECTION_ID,
        label: "Marketplace",
        order: 20,
        icon: MARKETPLACE_ICON_SVG,
      })

      void reg.registerItem({
        id: ITEM_ID,
        sectionId: SECTION_ID,
        label: "Enable marketplace",
        description:
          "Show the Marketplace tab in the left sidebar for browsing and installing plugins.",
        group: "General",
        order: 0,
        keywords: ["plugins", "extensions", "browse", "install"],
        control: {
          kind: "toggle",
          value: this.ctx.db.client.readRoot().plugins.enabled,
        },
        rpc: {
          plugin: "plugins",
          service: "marketplaceSettings",
          method: "setEnabled",
        },
      })

      return () => {
        void reg.unregisterItem({ id: ITEM_ID })
        void reg.unregisterSection({ id: SECTION_ID })
      }
    })
  }

  async setEnabled(args: {
    value: boolean
    windowId?: string
  }): Promise<{ ok: true }> {
    if (typeof args.value !== "boolean") return { ok: true }
    await this.ctx.db.client.update(root => {
      root.plugins.enabled = args.value
    })
    await (this.ctx.settingsRegistry as SettingsRegistry).setValue({
      id: ITEM_ID,
      value: args.value,
    })
    return { ok: true }
  }
}

const MARKETPLACE_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9h18M3 9l1.5-4.5A2 2 0 0 1 6.4 3h11.2a2 2 0 0 1 1.9 1.5L21 9M3 9v9a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9M9 13h6"/></svg>`
