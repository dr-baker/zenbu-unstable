import { Service } from "@zenbujs/core/runtime"
import {
  DbService,
  WindowService,
} from "@zenbujs/core/services"
import { buildContextMenuPrepend } from "../lib/context-menu-prepend"

/** Single shared window that hosts the standalone chat-tab strip. We
 * only ever spawn one of these — repeated `open()` calls append a new
 * tab and focus the existing window instead of spawning duplicates. */
const CHAT_WINDOW_ID = "chat-stack"

/**
 * Window management for the standalone chat-tab window: `open()` /
 * `closeTab()` / `activateTab()` RPCs that drive the tab strip.
 *
 * The `"chat-window"` VIEW itself is registered by the chat plugin
 * (`ChatSurfaceService`) — this service only opens windows that point
 * at that injection name. Tab state lives in
 * `root.app.chatWindows[CHAT_WINDOW_ID]` so it survives reloads and
 * is rendered straight from the DB replica with no extra round trips.
 */
export class ChatWindowService extends Service.create({
  key: "chatWindow",
  deps: {
    window: WindowService,
    db: DbService,
  },
}) {

  /**
   * Open (or focus) the shared chat window with `chatId` added as a
   * tab. If the chat is already a tab, it's just made active; if not,
   * it's appended to the right of the strip.
   */
  async open(args: { chatId: string }): Promise<{ windowId: string }> {
    await this.ctx.db.client.update(root => {
      const state = root.app.chatWindows[CHAT_WINDOW_ID] ?? {
        tabs: [],
        activeChatId: null,
      }
      if (!state.tabs.includes(args.chatId)) {
        state.tabs.push(args.chatId)
      }
      state.activeChatId = args.chatId
      root.app.chatWindows[CHAT_WINDOW_ID] = state
    })

    return this.ctx.window.openWindow({
      injection: "chat-window",
      windowId: CHAT_WINDOW_ID,
      baseWindow: {
        width: 820,
        height: 820,
        minWidth: 350,
        minHeight: 310,
        trafficLightPosition: { x: 14, y: 12 },
      },
      contextMenu: { prepend: buildContextMenuPrepend() },
    })
  }
}
