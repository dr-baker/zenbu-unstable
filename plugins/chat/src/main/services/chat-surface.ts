import { Service } from "@zenbujs/core/runtime"

/**
 * Registers the chat surface's renderer entry points:
 *
 *  - `"chat-pane"` — the chat pane component the app shell mounts in
 *    every chat tab (see the shell's `ChatPaneSlot`). Registered as a
 *    plain component injection so the shell stays decoupled from this
 *    plugin's module graph.
 *  - `"chat-data-warmer"` — optional data-only background warmer used by
 *    the app shell for likely tab-switch targets. It hydrates event logs and
 *    fills the renderer materialization cache without mounting hidden chat UI.
 *  - `"chat-window"` — the standalone chat window view. The app's
 *    `ChatWindowService` keeps window management (`open`/`closeTab` +
 *    `root.app.chatWindows`); it opens windows by this injection name.
 *
 * Module paths resolve against this plugin's root. The component file
 * layout deliberately preserves the old `components/chat/...` /
 * `components/composer/...` path tails so existing advice
 * (`moduleId` suffix matching) keeps attaching without changes.
 */
export class ChatSurfaceService extends Service.create({
  key: "chatSurface",
}) {
  evaluate() {
    this.setup("register-chat-pane", () =>
      this.inject({
        name: "chat-pane",
        modulePath: "src/renderer/components/chat/chat-pane.tsx",
        exportName: "ChatPane",
        meta: { kind: "component", label: "Chat pane" },
      }),
    )
    this.setup("register-chat-data-warmer", () =>
      this.inject({
        name: "chat-data-warmer",
        modulePath: "src/renderer/components/chat/chat-data-warmer.tsx",
        exportName: "ChatDataWarmer",
        meta: { kind: "component", label: "Chat data warmer" },
      }),
    )
    this.setup("register-chat-window-view", () =>
      this.inject({
        name: "chat-window",
        modulePath: "src/renderer/views/chat-window/chat-window-app.tsx",
        exportName: "ChatWindowApp",
        meta: { kind: "view", label: "Chat" },
      }),
    )
  }
}
