import { Service } from "@zenbujs/core/runtime";
import { DbService } from "@zenbujs/core/services";
import { SettingsRegistryService } from "./settings-registry";

/**
 * Demo bridge: contributes the host application's built-in settings
 * (theme / default send mode / vim mode / sidebar chat sort) into
 * the generic settings registry so the new "Plugins" tab isn't
 * empty out of the box.
 *
 * This is also the canonical pattern for any plugin that wants to
 * contribute settings:
 *
 *  1. Depend on `SettingsRegistryService` and `DbService`.
 *  2. In `setup()`, call `registerSection` + one `registerItem`
 *     per control. Pair each with the matching `unregister*` in
 *     the cleanup.
 *  3. Expose an RPC handler per item (or a single switch-style
 *     handler if you prefer) that:
 *       - Writes the new value into wherever the underlying state
 *         lives (your own plugin's DB, a config file, an external
 *         API …).
 *       - Calls `settingsRegistry.setValue({ id, value })` so the
 *         displayed value stays in sync.
 *
 * Living inside the settings plugin (which already `dependsOn`
 * `app` for typed DB access) avoids a circular plugin dependency:
 * the host `app` plugin doesn't need to know that `settings`
 * exists. Real third-party plugins are expected to host their own
 * bridge service in their own package.
 */
const SECTION_ID = "app";

const ITEM_IDS = {
  theme: "app.theme",
  sendMode: "app.defaultSendMode",
  vimMode: "app.vimMode",
  chatDevtools: "app.chatDevtools",
  disableTelemetry: "app.disableTelemetry",
} as const;

export class AppSettingsBridgeService extends Service.create({
  key: "appSettingsBridge",
  deps: {
    settingsRegistry: SettingsRegistryService,
    db: DbService,
  },
}) {
  evaluate() {
    this.setup("register-app-section", () => {
      const reg = this.ctx.settingsRegistry;
      const settings = this.ctx.db.client.readRoot().app.settings;

      void reg.registerSection({
        id: SECTION_ID,
        label: "App",
        order: 0,
        icon: APP_ICON_SVG,
      });

      void reg.registerItem({
        id: ITEM_IDS.theme,
        sectionId: SECTION_ID,
        label: "Theme",
        description: "Light, dark, or follow the system preference.",
        group: "Appearance",
        order: 0,
        keywords: ["color", "dark mode", "light mode", "oled"],
        control: {
          kind: "select",
          value: settings.theme,
          options: [
            { value: "light", label: "Light" },
            { value: "dark", label: "Dark" },
            { value: "oled", label: "OLED" },
            { value: "system", label: "System" },
          ],
        },
        rpc: {
          plugin: "settings",
          service: "appSettingsBridge",
          method: "setTheme",
        },
      });

      void reg.registerItem({
        id: ITEM_IDS.sendMode,
        sectionId: SECTION_ID,
        label: "Default send mode",
        description:
          "What plain Enter does in the composer while the agent is streaming.",
        group: "Chat",
        order: 0,
        keywords: ["enter", "compose", "queue", "steer", "follow up"],
        control: {
          kind: "select",
          value: settings.defaultSendMode,
          options: [
            { value: "followUp", label: "Queue" },
            { value: "steer", label: "Steer" },
          ],
        },
        rpc: {
          plugin: "settings",
          service: "appSettingsBridge",
          method: "setDefaultSendMode",
        },
      });

      void reg.registerItem({
        id: ITEM_IDS.vimMode,
        sectionId: SECTION_ID,
        label: "Vim mode in composer",
        description:
          "Enables vim keybindings in the chat composer and other code-editing surfaces.",
        group: "Chat",
        order: 1,
        keywords: ["editor", "keybindings", "modal"],
        control: {
          kind: "toggle",
          value: settings.vimMode,
        },
        rpc: {
          plugin: "settings",
          service: "appSettingsBridge",
          method: "setVimMode",
        },
      });

      void reg.registerItem({
        id: ITEM_IDS.disableTelemetry,
        sectionId: SECTION_ID,
        label: "Disable anonymous telemetry",
        description:
          "Stops the app from sending anonymous product.",
        group: "Privacy",
        order: 0,
        keywords: [
          "analytics",
          "telemetry",
          "posthog",
          "tracking",
          "privacy",
          "opt out",
        ],
        control: {
          kind: "toggle",
          value: settings.disableTelemetry,
        },
        rpc: {
          plugin: "settings",
          service: "appSettingsBridge",
          method: "setDisableTelemetry",
        },
      });

      void reg.registerItem({
        id: ITEM_IDS.chatDevtools,
        sectionId: SECTION_ID,
        label: "Chat devtools",
        description: "Show the invariant overlay pill in chats.",
        group: "Developer",
        order: 0,
        keywords: [
          "devtools",
          "invariant",
          "overlay",
          "debug",
          "diagnostics",
          "chat",
        ],
        control: {
          kind: "toggle",
          value: settings.chatDevtools,
        },
        rpc: {
          plugin: "settings",
          service: "appSettingsBridge",
          method: "setChatDevtools",
        },
      });

      return () => {
        for (const id of Object.values(ITEM_IDS)) {
          void reg.unregisterItem({ id });
        }
        void reg.unregisterSection({ id: SECTION_ID });
      };
    });

    // Note: we intentionally don't subscribe to `app.settings`
    // changes here — the underlying db.client API is collection-
    // shaped (`client.app.scopes.subscribe(…)`) and the
    // `settings` field is a single data object. The bridge
    // handlers below always call `setValue` themselves after a
    // mutation, which keeps the registry in sync for the
    // happy path. The legacy General tab (which still writes
    // directly to `app.settings`) is the only thing that can
    // desync the displayed value, and it's only one tab away.
  }

  async setTheme(args: {
    value: string;
    windowId?: string;
  }): Promise<{ ok: true }> {
    const next = args.value;
    if (
      next !== "light" &&
      next !== "dark" &&
      next !== "oled" &&
      next !== "system"
    ) {
      return { ok: true };
    }
    await this.ctx.db.client.update((root) => {
      root.app.settings.theme = next;
    });
    await this.ctx.settingsRegistry.setValue({
      id: ITEM_IDS.theme,
      value: next,
    });
    return { ok: true };
  }

  async setDefaultSendMode(args: {
    value: string;
    windowId?: string;
  }): Promise<{ ok: true }> {
    const next = args.value;
    if (next !== "followUp" && next !== "steer") return { ok: true };
    await this.ctx.db.client.update((root) => {
      root.app.settings.defaultSendMode = next;
    });
    await this.ctx.settingsRegistry.setValue({
      id: ITEM_IDS.sendMode,
      value: next,
    });
    return { ok: true };
  }

  async setVimMode(args: {
    value: boolean;
    windowId?: string;
  }): Promise<{ ok: true }> {
    if (typeof args.value !== "boolean") return { ok: true };
    await this.ctx.db.client.update((root) => {
      root.app.settings.vimMode = args.value;
    });
    await this.ctx.settingsRegistry.setValue({
      id: ITEM_IDS.vimMode,
      value: args.value,
    });
    return { ok: true };
  }

  async setChatDevtools(args: {
    value: boolean;
    windowId?: string;
  }): Promise<{ ok: true }> {
    if (typeof args.value !== "boolean") return { ok: true };
    await this.ctx.db.client.update((root) => {
      root.app.settings.chatDevtools = args.value;
    });
    await this.ctx.settingsRegistry.setValue({
      id: ITEM_IDS.chatDevtools,
      value: args.value,
    });
    return { ok: true };
  }

  async setDisableTelemetry(args: {
    value: boolean;
    windowId?: string;
  }): Promise<{ ok: true }> {
    if (typeof args.value !== "boolean") return { ok: true };
    await this.ctx.db.client.update((root) => {
      root.app.settings.disableTelemetry = args.value;
    });
    await this.ctx.settingsRegistry.setValue({
      id: ITEM_IDS.disableTelemetry,
      value: args.value,
    });
    return { ok: true };
  }

}

// Small lucide-style sliders glyph for the sidebar tile.
const APP_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/></svg>`;
