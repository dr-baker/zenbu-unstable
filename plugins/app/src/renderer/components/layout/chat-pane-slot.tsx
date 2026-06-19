import type { ComponentType } from "react"
import * as coreReact from "@zenbujs/core/react"
import type { Schema } from "../../../main/schema"
import type { PerfTraceContext } from "@/lib/perf-trace"

const { useInjection } = coreReact

/**
 * Local mirror of `@zenbujs/core/react`'s `InjectionLoadFailure`, kept
 * local so this file doesn't hard-depend on the type export existing.
 */
type InjectionLoadFailure = {
  name: string
  modulePath: string
  pluginDir?: string
  error: unknown
}

/**
 * Soft-resolve `useInjectionFailure`. Older `@zenbujs/core` builds don't
 * export it, and a static named import of a missing export throws at
 * module load — which wedges the entire renderer (a stale published core
 * leaking back into the dep tree is exactly how that happens). Reaching
 * for it off the namespace yields `undefined` for an absent member
 * instead, so on older core we degrade to a no-op hook (no failure card)
 * rather than a hard crash. The binding is resolved once at module load,
 * so the hook call stays consistent across renders.
 */
const useInjectionFailure: (name: string) => InjectionLoadFailure | undefined =
  ((coreReact as Record<string, unknown>).useInjectionFailure as
    | ((name: string) => InjectionLoadFailure | undefined)
    | undefined) ?? (() => undefined)

type Chat = Schema["chats"][string]
type PendingChatPane = {
  scopeId: string
  composerId: string
}

/**
 * Structural mirror of the chat plugin's `ChatPaneProps`. The shell
 * deliberately doesn't import the chat plugin's module graph — the
 * pane arrives through the `"chat-pane"` injection registered by
 * `plugins/chat` (ChatSurfaceService), same seam any plugin would use
 * to replace the chat surface wholesale.
 */
export type ChatPaneSlotProps = {
  chat: Chat | null
  /** Unmaterialized chat tab. The shell creates no chat/session row
   * until the chat pane calls `createPendingChat` on first submit. */
  pendingChat?: PendingChatPane
  createPendingChat?: () => Promise<{ chatId: string; sessionId: string }>
  leftAdjacent?: boolean
  bottomAdjacent?: boolean
  rightAdjacent?: boolean
  topAdjacent?: boolean
  traceContext?: PerfTraceContext
}

/**
 * Mounts whatever component is registered under `"chat-pane"`. Three
 * states, and the distinction matters:
 *
 *  - registered → render it.
 *  - failed to load → render the failure, loudly. The injection
 *    registry records load failures (module threw during evaluation,
 *    or the export is missing); a chat pane that silently never
 *    arrives is a debugging trap, so the slot names the culprit
 *    instead. House rule: every silent fallback must be paired with
 *    an interrogable status.
 *  - still loading (or chat plugin disabled) → empty frame; the
 *    registry is reactive, so the real pane pops in the moment it
 *    registers.
 */
export function ChatPaneSlot(props: ChatPaneSlotProps) {
  const ChatPane = useInjection<ComponentType<ChatPaneSlotProps>>("chat-pane")
  const failure = useInjectionFailure("chat-pane")
  if (!ChatPane) {
    if (failure) {
      return (
        <div className="flex h-full w-full items-center justify-center p-6">
          <div className="max-w-lg space-y-2 rounded-md border border-red-500/40 bg-red-500/5 p-4 text-sm">
            <div className="font-medium text-red-500">
              Chat pane failed to load
            </div>
            <div className="text-muted-foreground">
              The <code>chat-pane</code> injection
              {failure.pluginDir ? (
                <> from <code>{failure.pluginDir}</code></>
              ) : null}{" "}
              threw while loading <code>{failure.modulePath}</code>.
            </div>
            <pre className="overflow-auto whitespace-pre-wrap rounded bg-black/20 p-2 text-xs">
              {String(
                (failure.error as { stack?: string })?.stack ?? failure.error,
              )}
            </pre>
          </div>
        </div>
      )
    }
    return <div className="h-full w-full" />
  }
  return <ChatPane {...props} />
}
