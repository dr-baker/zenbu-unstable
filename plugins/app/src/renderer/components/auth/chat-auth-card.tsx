import { useDb, useDbClient, useRpc } from "@zenbujs/core/react"
import { ArrowRight } from "lucide-react"
import { Button } from "@zenbu/ui/button"
import { useWindowId } from "@/lib/window-state/window-id"
import { openViewInRoot } from "@/lib/window-state/panes/views"

/**
 * The three featured subscription providers — same order pi shows
 * in `/login`. Surfaced as one-click "Sign in with X" buttons.
 *
 * Kept in sync (by convention, not import) with
 * `FEATURED_SUBSCRIPTION_IDS` in `services/auth.ts`.
 */
const FEATURED: ReadonlyArray<{ id: string; label: string; hint: string }> = [
  {
    id: "anthropic",
    label: "Sign in with Claude",
    hint: "Anthropic Pro / Max",
  },
  {
    id: "openai-codex",
    label: "Sign in with ChatGPT",
    hint: "ChatGPT Plus / Pro Codex",
  },
  {
    id: "github-copilot",
    label: "Sign in with GitHub Copilot",
    hint: "via GitHub",
  },
]

/**
 * Inline card shown in the chat composer slot when no provider has
 * auth configured. Three subscription one-clicks plus an escape
 * hatch to the Accounts settings tab.
 *
 * Click flow:
 *   - "Sign in with X"  → `rpc.pi.auth.startOAuthLogin({...})`,
 *     which kicks off pi's `auth.login()`. The global
 *     `<OAuthFlowModal />` (mounted in `<App />`) renders the
 *     multi-step flow off `root.pi.oauthFlow`.
 *   - "More options"    → opens the Accounts settings tab in a new
 *     tab via `openViewInRoot(..., { tab: "accounts" })`. We
 *     intentionally don't use the global "open settings" event
 *     here — that defaults to the General tab and we want to
 *     deep-link to Accounts.
 *
 * The card disappears the moment any provider becomes configured,
 * because `refreshAvailableModels()` re-runs after every auth
 * mutation and the parent (`<ChatPane>`) only mounts us when
 * `Object.keys(root.pi.models).length === 0`.
 */
export function ChatAuthCard() {
  const rpc = useRpc()
  const windowId = useWindowId()
  const dbClient = useDbClient()
  const statuses = useDb(root => root.pi.providerStatuses)

  const onSignIn = async (providerId: string) => {
    try {
      await rpc.pi.auth.startOAuthLogin({ providerId })
    } catch (err) {
      console.error("[chat-auth-card] startOAuthLogin failed:", err)
    }
  }

  const onMoreOptions = () => {
    void dbClient.update(root => {
      openViewInRoot(root, windowId, "settings", "new-tab", {
        tab: "accounts",
      })
    })
  }

  return (
    <div className="mx-3 mb-3 flex flex-col gap-3 rounded-lg border border-border bg-card p-4 shadow-sm">
      <div className="flex flex-col gap-1">
        <h3 className="text-[13px] font-semibold text-foreground">
          Sign in to start chatting
        </h3>
        <p className="text-[12px] text-muted-foreground">
          Pi needs an AI provider configured before it can run. Use an
          existing subscription, or set an API key.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        {FEATURED.map(provider => {
          const status = statuses[provider.id]
          const configured = status?.configured === true
          return (
            <Button
              key={provider.id}
              variant="outline"
              className="h-auto justify-between px-3 py-2.5"
              onClick={() => void onSignIn(provider.id)}
            >
              <div className="flex flex-col items-start gap-0.5">
                <span className="text-[13px] font-medium">
                  {provider.label}
                </span>
                <span className="text-[11px] font-normal text-muted-foreground">
                  {configured ? "Reconnect" : provider.hint}
                </span>
              </div>
              <ArrowRight className="h-4 w-4 text-muted-foreground" />
            </Button>
          )
        })}
      </div>

      <button
        type="button"
        onClick={onMoreOptions}
        className="self-start text-[12px] font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
      >
        More options (API keys, OpenRouter, custom providers) →
      </button>
    </div>
  )
}
