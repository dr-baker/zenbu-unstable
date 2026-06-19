import { useEffect, useMemo, useState, type ChangeEvent, type KeyboardEvent } from "react"
import { useDb, useRpc } from "@zenbujs/core/react"
import { MoreHorizontal } from "lucide-react"
import { Button } from "@zenbu/ui/button"
import { Input } from "@zenbu/ui/input"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@zenbu/ui/dropdown-menu"

/**
 * Per-provider status row owned by the app plugin
 * (`root.pi.providerStatuses[id]`). Pulled out via
 * `ReturnType` of the `useDb` selector so we stay in sync with
 * whatever the app schema exposes through the `dependsOn: app`
 * typed surface — no manual mirroring.
 */
type Status = ReturnType<typeof useStatuses>[string]
function useStatuses() {
  return useDb(root => root.pi.providerStatuses)
}

type CatalogEntry = {
  id: string
  kind: "subscription" | "apiKey" | "cloud"
  displayName: string
  envVar: string | null
  tagline: string
  supportsApiKey?: boolean
}

/**
 * The "Accounts" tab of Settings. Three groups: Subscriptions,
 * API keys, Cloud providers. Each row collapses to a single line —
 * name, status, primary action, overflow menu. Taglines / env-var
 * hints / source-detail labels are intentionally not surfaced here;
 * they live in the docs and in the overflow menu copy.
 */
export function AccountsPanel() {
  const rpc = useRpc()
  const statuses = useStatuses()
  const [catalog, setCatalog] = useState<CatalogEntry[] | null>(null)

  useEffect(() => {
    let cancelled = false
    rpc.pi.auth
      .listCatalog()
      .then(entries => {
        if (!cancelled) setCatalog(entries)
      })
      .catch(err => {
        console.error("[accounts] listCatalog failed:", err)
      })
    return () => {
      cancelled = true
    }
  }, [rpc])

  const groups = useMemo(() => {
    if (!catalog) return null
    const subs: CatalogEntry[] = []
    const apiKeys: CatalogEntry[] = []
    const cloud: CatalogEntry[] = []
    for (const entry of catalog) {
      if (entry.kind === "subscription") subs.push(entry)
      else if (entry.kind === "apiKey") apiKeys.push(entry)
      else cloud.push(entry)
    }
    return { subs, apiKeys, cloud }
  }, [catalog])

  if (!groups) {
    return (
      <div className="pt-6 text-[12px] text-muted-foreground">Loading…</div>
    )
  }

  return (
    <div className="flex flex-col gap-6 pt-3 pb-8">
      <Section title="Subscriptions">
        {groups.subs.map(entry => (
          <ProviderRow
            key={entry.id}
            entry={entry}
            status={statuses[entry.id]}
          />
        ))}
      </Section>

      <Section title="API keys">
        {groups.apiKeys.map(entry => (
          <ProviderRow
            key={entry.id}
            entry={entry}
            status={statuses[entry.id]}
          />
        ))}
      </Section>

      <Section title="Cloud">
        {groups.cloud.map(entry => (
          <ProviderRow
            key={entry.id}
            entry={entry}
            status={statuses[entry.id]}
          />
        ))}
      </Section>
    </div>
  )
}

function Section({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </h2>
      <div className="flex flex-col divide-y divide-border rounded-md border border-border">
        {children}
      </div>
    </section>
  )
}

function ProviderRow({
  entry,
  status,
}: {
  entry: CatalogEntry
  status: Status | undefined
}) {
  return (
    <div className="flex h-11 items-center justify-between gap-3 px-3">
      <span className="truncate text-[13px] text-foreground">
        {entry.displayName}
      </span>
      <RowAction entry={entry} status={status} />
    </div>
  )
}

function RowAction({
  entry,
  status,
}: {
  entry: CatalogEntry
  status: Status | undefined
}) {
  if (entry.kind === "subscription") {
    return <SubscriptionAction entry={entry} status={status} />
  }
  if (entry.kind === "apiKey") {
    return <ApiKeyAction entry={entry} status={status} />
  }
  return <CloudAction entry={entry} />
}

function MoreMenu({ children }: { children: React.ReactNode }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 text-muted-foreground"
          aria-label="More options"
        >
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function SubscriptionAction({
  entry,
  status,
}: {
  entry: CatalogEntry
  status: Status | undefined
}) {
  const rpc = useRpc()
  const connected = status?.configured === true
  const isStored = status?.source === "stored"
  const isEnv = status?.source === "environment"
  const credentialType = status?.credentialType ?? null
  const supportsApiKey = entry.supportsApiKey === true

  const [showApiKey, setShowApiKey] = useState(false)

  const onConnect = async () => {
    try {
      await rpc.pi.auth.startOAuthLogin({ providerId: entry.id })
    } catch (err) {
      console.error("[accounts] startOAuthLogin failed:", err)
    }
  }

  const onDisconnect = async () => {
    try {
      await rpc.pi.auth.removeAuth({ providerId: entry.id })
      setShowApiKey(false)
    } catch (err) {
      console.error("[accounts] removeAuth failed:", err)
    }
  }

  if (showApiKey && supportsApiKey) {
    return (
      <ApiKeyInline entry={entry} onClose={() => setShowApiKey(false)} />
    )
  }

  if (connected) {
    return (
      <div className="flex shrink-0 items-center gap-1">
        <span className="text-[12px] text-muted-foreground">
          {isEnv ? "Env" : credentialType === "oauth" ? "OAuth" : "API key"}
        </span>
        <MoreMenu>
          {credentialType === "oauth" ? (
            <DropdownMenuItem onSelect={onConnect}>Re-auth</DropdownMenuItem>
          ) : null}
          {supportsApiKey && credentialType !== "api_key" ? (
            <DropdownMenuItem onSelect={() => setShowApiKey(true)}>
              {isEnv ? "Override with key" : "Use API key"}
            </DropdownMenuItem>
          ) : null}
          {credentialType === "api_key" ? (
            <>
              <DropdownMenuItem onSelect={() => setShowApiKey(true)}>
                Replace key
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={onConnect}>
                Use OAuth
              </DropdownMenuItem>
            </>
          ) : null}
          {isEnv ? (
            <DropdownMenuItem onSelect={onConnect}>
              Sign in instead
            </DropdownMenuItem>
          ) : null}
          {isStored ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={onDisconnect}>
                Disconnect
              </DropdownMenuItem>
            </>
          ) : null}
        </MoreMenu>
      </div>
    )
  }

  return (
    <div className="flex shrink-0 items-center gap-1">
      <Button size="sm" variant="outline" onClick={onConnect} className="h-7">
        Sign in
      </Button>
      {supportsApiKey ? (
        <MoreMenu>
          <DropdownMenuItem onSelect={() => setShowApiKey(true)}>
            Use API key
          </DropdownMenuItem>
        </MoreMenu>
      ) : null}
    </div>
  )
}

/**
 * Inline API-key input used by both apiKey-kind rows and the
 * subscription rows' "Use API key" path.
 */
function ApiKeyInline({
  entry,
  onClose,
}: {
  entry: CatalogEntry
  onClose: (() => void) | null
}) {
  const rpc = useRpc()
  const [value, setValue] = useState("")
  const [saving, setSaving] = useState(false)

  const onSave = async () => {
    if (!value.trim()) return
    setSaving(true)
    try {
      await rpc.pi.auth.setApiKey({ providerId: entry.id, key: value })
      setValue("")
      onClose?.()
    } catch (err) {
      console.error("[accounts] setApiKey failed:", err)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex shrink-0 items-center gap-1">
      <Input
        type="password"
        placeholder="Paste API key"
        value={value}
        onChange={(e: ChangeEvent<HTMLInputElement>) => setValue(e.target.value)}
        onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
          if (e.key === "Enter") void onSave()
          if (e.key === "Escape" && onClose) onClose()
        }}
        className="h-7 w-[220px] text-[12px]"
        autoFocus
        disabled={saving}
      />
      <Button
        size="sm"
        onClick={onSave}
        disabled={saving || !value.trim()}
        className="h-7"
      >
        Save
      </Button>
      {onClose ? (
        <Button
          size="sm"
          variant="ghost"
          onClick={onClose}
          disabled={saving}
          className="h-7"
        >
          Cancel
        </Button>
      ) : null}
    </div>
  )
}

function ApiKeyAction({
  entry,
  status,
}: {
  entry: CatalogEntry
  status: Status | undefined
}) {
  const rpc = useRpc()
  const connected = status?.configured === true
  const isEnv = status?.source === "environment"
  const [editing, setEditing] = useState(false)

  const onRemove = async () => {
    try {
      await rpc.pi.auth.removeAuth({ providerId: entry.id })
    } catch (err) {
      console.error("[accounts] removeAuth failed:", err)
    }
  }

  if (editing) {
    return (
      <ApiKeyInline entry={entry} onClose={() => setEditing(false)} />
    )
  }

  if (!connected) {
    return (
      <Button
        size="sm"
        variant="outline"
        onClick={() => setEditing(true)}
        className="h-7"
      >
        Add key
      </Button>
    )
  }

  return (
    <div className="flex shrink-0 items-center gap-1">
      <span className="text-[12px] text-muted-foreground">
        {isEnv ? "Env" : "Stored"}
      </span>
      <MoreMenu>
        <DropdownMenuItem onSelect={() => setEditing(true)}>
          {isEnv ? "Override with key" : "Replace key"}
        </DropdownMenuItem>
        {!isEnv ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={onRemove}>
              Remove
            </DropdownMenuItem>
          </>
        ) : null}
      </MoreMenu>
    </div>
  )
}

function CloudAction({ entry }: { entry: CatalogEntry }) {
  const docsAnchor = cloudDocsAnchor(entry.id)
  return (
    <a
      href={`https://pi.dev/docs/providers#${docsAnchor}`}
      target="_blank"
      rel="noopener noreferrer"
      className="shrink-0 text-[12px] text-muted-foreground hover:text-foreground"
    >
      Docs
    </a>
  )
}

function cloudDocsAnchor(id: string): string {
  switch (id) {
    case "azure-openai-responses":
      return "azure-openai"
    case "amazon-bedrock":
      return "amazon-bedrock"
    case "cloudflare-ai-gateway":
      return "cloudflare-ai-gateway"
    case "cloudflare-workers-ai":
      return "cloudflare-workers-ai"
    case "google-vertex":
      return "google-vertex-ai"
    default:
      return "cloud-providers"
  }
}
