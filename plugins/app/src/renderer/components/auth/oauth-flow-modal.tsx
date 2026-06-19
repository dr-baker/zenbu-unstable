import { useEffect, useRef, useState } from "react"
import { useDb, useRpc } from "@zenbujs/core/react"
import { ExternalLink, Loader2 } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@zenbu/ui/dialog"
import { Button } from "@zenbu/ui/button"
import { Input } from "@zenbu/ui/input"
import type { SelfDbSection as PiSchema } from "../../../../.zenbu/types/deps/pi/db-sections"

type Flow = NonNullable<PiSchema["oauthFlow"]>

/**
 * Global OAuth login modal. Listens to `root.pi.oauthFlow`, which
 * is owned by `AuthService` (main process) and updated as pi calls
 * back through `auth.login()`'s callbacks.
 *
 * Rendered once at the top of the app tree (`<App />`). Renders
 * nothing when no flow is in flight. The modal is uncloseable via
 * the ESC / overlay — closing happens through explicit Cancel /
 * Done buttons so we always pass through the cancel RPC and abort
 * pi's callback server cleanly.
 *
 * Step-by-step:
 *   - `starting`   — spinner while pi spins up its callback server
 *   - `openUrl`    — pi gave us a URL; we've already opened it
 *   - `select`     — pi wants a choice from a list
 *   - `prompt`     — pi wants a text input (e.g. GHES domain)
 *   - `manualCode` — paste-the-code fallback
 *   - `completing` — pi is exchanging the code for a token
 *   - `error`      — terminal; show message + Try again
 */
export function OAuthFlowModal() {
  const flow = useDb(root => root.pi.oauthFlow)
  if (!flow) return null
  return <ModalInner flow={flow} />
}

function ModalInner({ flow }: { flow: Flow }) {
  const rpc = useRpc()

  const onCancel = () => {
    void rpc.pi.auth.cancelOAuthLogin({ flowId: flow.flowId })
  }
  const onDismiss = () => {
    void rpc.pi.auth.dismissOAuthError({ flowId: flow.flowId })
  }

  return (
    <Dialog
      open
      // We don't allow the dialog to close itself via overlay click
      // or ESC — we always want to go through the cancel RPC so
      // pi's internal callback server is torn down properly.
      onOpenChange={open => {
        if (!open) {
          if (flow.step === "error") onDismiss()
          else onCancel()
        }
      }}
    >
      <DialogContent showCloseButton={false} className="sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle>Sign in to {flow.displayName}</DialogTitle>
          <DialogDescription>
            {stepHeadline(flow)}
          </DialogDescription>
        </DialogHeader>

        <StepBody flow={flow} />

        {flow.progress.length > 0 ? (
          <div className="rounded-md border border-border bg-muted/30 px-3 py-2">
            <p className="text-[11px] text-muted-foreground">
              {flow.progress[0]}
            </p>
          </div>
        ) : null}

        <div className="flex justify-end">
          {flow.step === "error" ? (
            <Button variant="outline" onClick={onDismiss}>
              Close
            </Button>
          ) : (
            <Button variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function stepHeadline(flow: Flow): string {
  switch (flow.step) {
    case "starting":
      return "Starting sign-in…"
    case "openUrl":
      return "Complete the sign-in in your browser. We'll detect when you're done automatically."
    case "select":
      return flow.selectMessage ?? "Choose an option."
    case "prompt":
      return flow.promptMessage ?? "Enter the requested value."
    case "manualCode":
      return "Paste the code from the redirect URL. Pi will exchange it for a token."
    case "completing":
      return "Finishing sign-in…"
    case "error":
      return flow.errorMessage ?? "Sign-in failed."
  }
}

function StepBody({ flow }: { flow: Flow }) {
  if (flow.step === "starting" || flow.step === "completing") {
    return (
      <div className="flex items-center gap-3 rounded-md border border-border bg-muted/30 px-4 py-4">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        <span className="text-[12px] text-muted-foreground">
          Talking to Pi…
        </span>
      </div>
    )
  }
  if (flow.step === "openUrl") {
    return <OpenUrlBody flow={flow} />
  }
  if (flow.step === "select") {
    return <SelectBody flow={flow} />
  }
  if (flow.step === "prompt") {
    return <PromptBody flow={flow} />
  }
  if (flow.step === "manualCode") {
    return <ManualCodeBody flow={flow} />
  }
  // error
  return (
    <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2">
      <p className="text-[12px] text-destructive">
        {flow.errorMessage ?? "Unknown error"}
      </p>
    </div>
  )
}

function OpenUrlBody({ flow }: { flow: Flow }) {
  const rpc = useRpc()
  const url = flow.url ?? ""

  const onReopen = () => {
    void rpc.pi.auth.reopenOAuthUrl({ flowId: flow.flowId })
  }
  const onPasteCode = () => {
    void rpc.pi.auth.requestManualCodeInput({ flowId: flow.flowId })
  }

  return (
    <div className="flex flex-col gap-3">
      {flow.instructions ? (
        <p className="text-[12px] text-muted-foreground">
          {flow.instructions}
        </p>
      ) : null}
      <div className="flex flex-col gap-2 rounded-md border border-border bg-muted/30 px-3 py-3">
        <p className="text-[11px] font-medium text-foreground">
          Auth URL
        </p>
        <p className="overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[11px] text-muted-foreground">
          {url}
        </p>
        <div className="flex gap-2">
          <Button size="sm" onClick={onReopen}>
            <ExternalLink className="h-3.5 w-3.5" />
            Open in browser
          </Button>
          {flow.supportsManualCode ? (
            <Button size="sm" variant="ghost" onClick={onPasteCode}>
              Paste code instead
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function SelectBody({ flow }: { flow: Flow }) {
  const rpc = useRpc()
  const [busy, setBusy] = useState<string | null>(null)

  const onPick = async (optionId: string) => {
    setBusy(optionId)
    try {
      await rpc.pi.auth.selectOAuthOption({
        flowId: flow.flowId,
        optionId,
      })
    } catch (err) {
      console.error("[oauth] selectOAuthOption failed:", err)
      setBusy(null)
    }
  }

  return (
    <div className="flex flex-col gap-2">
      {flow.selectOptions.map(option => (
        <button
          key={option.id}
          type="button"
          onClick={() => void onPick(option.id)}
          disabled={busy !== null}
          className="flex w-full items-center justify-between rounded-md border border-border bg-card px-3 py-2 text-left text-[13px] font-medium text-foreground transition-colors hover:bg-accent hover:text-accent-foreground disabled:opacity-60"
        >
          <span>{option.label}</span>
          {busy === option.id ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : null}
        </button>
      ))}
    </div>
  )
}

function PromptBody({ flow }: { flow: Flow }) {
  const rpc = useRpc()
  const [value, setValue] = useState("")
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const canSubmit = flow.promptAllowEmpty || value.trim().length > 0

  const onSubmit = async () => {
    if (!canSubmit) return
    setBusy(true)
    try {
      await rpc.pi.auth.submitOAuthPrompt({
        flowId: flow.flowId,
        value,
      })
    } catch (err) {
      console.error("[oauth] submitOAuthPrompt failed:", err)
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <Input
        ref={inputRef}
        type="text"
        value={value}
        placeholder={flow.promptPlaceholder ?? ""}
        onChange={e => setValue(e.target.value)}
        onKeyDown={e => {
          if (e.key === "Enter" && canSubmit) void onSubmit()
        }}
        disabled={busy}
      />
      <div className="flex justify-end">
        <Button onClick={onSubmit} disabled={busy || !canSubmit}>
          {busy ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Submitting…
            </>
          ) : (
            "Continue"
          )}
        </Button>
      </div>
    </div>
  )
}

function ManualCodeBody({ flow }: { flow: Flow }) {
  const rpc = useRpc()
  const [value, setValue] = useState("")
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const onSubmit = async () => {
    if (!value.trim()) return
    setBusy(true)
    try {
      await rpc.pi.auth.submitOAuthCode({
        flowId: flow.flowId,
        code: value.trim(),
      })
    } catch (err) {
      console.error("[oauth] submitOAuthCode failed:", err)
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[12px] text-muted-foreground">
        After signing in, copy the code from the redirect URL and paste
        it here.
      </p>
      <Input
        ref={inputRef}
        type="text"
        value={value}
        placeholder="Paste code or full redirect URL"
        onChange={e => setValue(e.target.value)}
        onKeyDown={e => {
          if (e.key === "Enter" && value.trim()) void onSubmit()
        }}
        disabled={busy}
      />
      <div className="flex justify-end">
        <Button onClick={onSubmit} disabled={busy || !value.trim()}>
          {busy ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Submitting…
            </>
          ) : (
            "Submit code"
          )}
        </Button>
      </div>
    </div>
  )
}
