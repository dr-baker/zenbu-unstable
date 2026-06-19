import { useState } from "react"
import { useDbClient, useRpc } from "@zenbujs/core/react"
import { AlertCircle, ChevronDown, LifeBuoy, Settings } from "lucide-react"
import { useWindowId } from "@/lib/window-state/window-id"
import { openViewInRoot } from "@/lib/window-state/panes/views"
import { cn } from "@/lib/utils"

const DISCORD_INVITE_URL = "https://discord.gg/THTQkeE7"

/**
 * Inline card for failed assistant turns (stopReason error/aborted).
 *
 * The expand/collapse uses a real button instead of `<details>` so
 * we can render a lucide chevron (instead of the UA's UTF caret),
 * skip the implicit `cursor: pointer`, and keep the row label
 * aligned with the rest of the chat's caret-on-the-right
 * convention.
 *
 * The footer is the same shape on every error: one row pointing at
 * Discord for live help, one deep-linking to the Accounts settings
 * tab (the most common cause of a hard failure is missing/expired
 * auth). External links go through `rpc.core.window.openExternal`
 * so they open in the user's default browser — we don't want a
 * Discord SPA to load inside an electron window.
 */
export function ErrorMessage({
  message,
  detail,
}: {
  message: string
  detail?: string | null
}) {
  const rpc = useRpc()
  const dbClient = useDbClient()
  const windowId = useWindowId()
  const headline = detail && detail.length > 0 ? detail : message
  const hasRaw = !!detail && detail !== message
  const [open, setOpen] = useState(false)

  const onOpenDiscord = () => {
    void rpc.core.window.openExternal(DISCORD_INVITE_URL).catch(err => {
      console.error("[error-message] openExternal failed:", err)
    })
  }

  const onOpenAccounts = () => {
    void dbClient.update(root => {
      openViewInRoot(root, windowId, "settings", "new-tab", {
        tab: "accounts",
      })
    })
  }

  return (
    <div className="my-1 w-full overflow-hidden rounded-md border border-border bg-card/40 text-sm text-foreground">
      <div className="px-2.5 py-1.5">
        <div className="flex items-center gap-1.5 text-[12px] font-medium text-destructive">
          <span>Request failed</span>
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
        </div>
        <div className="min-w-0">
          <div className="mt-0.5 whitespace-pre-wrap break-words text-foreground/90">
            {headline}
          </div>
          {hasRaw ? (
            <div className="mt-1">
              <button
                type="button"
                onClick={() => setOpen(v => !v)}
                aria-expanded={open}
                className="-mx-1 flex items-center gap-1 rounded px-1 py-0.5 text-[11px] text-muted-foreground hover:text-foreground"
              >
                <span>{open ? "Hide" : "Show"} raw response</span>
                <ChevronDown
                  className={cn(
                    "h-3 w-3 transition-transform",
                    open && "rotate-180",
                  )}
                />
              </button>
              {open ? (
                <pre className="mt-1 max-h-64 select-text overflow-auto whitespace-pre-wrap break-words rounded bg-muted/40 p-2 text-[11px] text-muted-foreground">
                  {message}
                </pre>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
      <div className="flex items-center gap-1 border-t border-border/60 px-1 py-1 text-[11px]">
        <ErrorFooterButton
          icon={<LifeBuoy className="h-3 w-3" />}
          label="Get support"
          onClick={onOpenDiscord}
        />
        <ErrorFooterButton
          icon={<Settings className="h-3 w-3" />}
          label="Accounts settings"
          onClick={onOpenAccounts}
        />
      </div>
    </div>
  )
}

function ErrorFooterButton({
  icon,
  label,
  onClick,
}: {
  icon: React.ReactNode
  label: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-1.5 rounded px-1.5 py-1 text-muted-foreground hover:bg-muted/50 hover:text-foreground"
    >
      {icon}
      <span>{label}</span>
    </button>
  )
}
