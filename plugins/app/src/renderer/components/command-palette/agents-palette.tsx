import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { useDb, useDbClient, useEvents } from "@zenbujs/core/react"
import { Input } from "@zenbu/ui/input"
// Rows render as plain <button>s, NOT a `ghost`-variant @zenbu/ui
// Button — the ghost variant's `hover:bg-accent` paints a phantom
// selection under the cursor while the keyboard-selected row is
// also highlighted, giving the palette two simultaneous active
// rows. Same fix the shared `PaletteRow` got.
import { cn } from "@/lib/utils"
import { ensureRowInView } from "@/lib/ensure-row-in-view"
import { useHoverIntent } from "@/lib/hooks/use-hover-intent"
import { chatLabel, resolveChatLabel } from "@/lib/chat-label"
import { useWindowId } from "@/lib/window-state/window-id"
import { useActiveScopeId } from "@/lib/window-state/active-view"
import { selectChatInRoot } from "@/lib/window-state/selection"
import type { Schema } from "../../../main/schema"
import type { SelfDbSection as PiSchema } from "../../../../.zenbu/types/deps/pi/db-sections"
import { PaletteShell } from "./palette-shell"
import { useArrowNav } from "./use-arrow-nav"

type Chat = Schema["chats"][string]
type Session = PiSchema["sessions"][string]

/**
 * Cmd+P focused palette: lists *sessions* (chats deduplicated by
 * `session.sessionId`) in the active scope and, on select, opens the
 * picked chat in the *current* pane via `selectChatInRoot`.
 *
 * TODO: this fetch-then-subscribe-per-row pattern (also used by the
 * sidebar) really belongs in kyju as a first-class "subscribable
 * derived value" with a server-side cache and replica-driven sync.
 * Until that lands we wire it up manually in each consumer.
 */
export function AgentsPalette() {
  const events = useEvents()
  const dbClient = useDbClient()
  const windowId = useWindowId()
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const off = events.app.toggleAgentsPalette.subscribe(() => {
      setOpen(o => !o)
    })
    return off
  }, [events])

  const close = useCallback(() => setOpen(false), [])

  const activeScopeId = useActiveScopeId()
  const chats = useDb(root => Object.values(root.app.chats))
  const sessionsById = useDb(root => root.pi.sessions)

  // Dedupe scope chats by sessionId — see AgentSidebarPane for the
  // same logic. The palette shows one row per session.
  const rows = useMemo<Chat[]>(() => {
    if (!activeScopeId) return []
    const scoped = chats.filter(c => c.scopeId === activeScopeId)
    const oldestFirst = scoped.slice().sort((a, b) => a.createdAt - b.createdAt)
    const seenSessions = new Set<string>()
    const deduped: Chat[] = []
    for (const chat of oldestFirst) {
      if (chat.session.kind !== "ready") {
        deduped.push(chat)
        continue
      }
      const sid = chat.session.sessionId
      if (seenSessions.has(sid)) continue
      // Hide archived sessions from the palette too.
      if (sessionsById[sid]?.archived) continue
      seenSessions.add(sid)
      deduped.push(chat)
    }
    return deduped.sort((a, b) => {
      const sa =
        a.session.kind === "ready"
          ? sessionsById[a.session.sessionId]
          : undefined
      const sb =
        b.session.kind === "ready"
          ? sessionsById[b.session.sessionId]
          : undefined
      const ta = sa?.lastActivityAt ?? a.createdAt
      const tb = sb?.lastActivityAt ?? b.createdAt
      return tb - ta
    })
  }, [activeScopeId, chats, sessionsById])

  const onActivate = useCallback(
    (chat: Chat) => {
      void dbClient.update(root => {
        selectChatInRoot(root, windowId, chat.id)
      })
      setOpen(false)
    },
    [dbClient, windowId],
  )

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-[1000] flex items-start justify-center pt-[12vh]"
      onClick={close}
    >
      <AgentsMenu
        rows={rows}
        sessionsById={sessionsById}
        onActivate={onActivate}
        onClose={close}
      />
    </div>
  )
}

/**
 * Stand-alone menu UI for the agents palette. We can't reuse the
 * general `<RootMenu>` because the shell, keyboard nav, and filter
 * UX need row-level rendering for status affordances.
 */
function AgentsMenu({
  rows,
  sessionsById,
  onActivate,
  onClose,
}: {
  rows: Chat[]
  sessionsById: Record<string, Session | undefined>
  onActivate: (chat: Chat) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState("")
  const [selected, setSelected] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const selectedRef = useRef<HTMLButtonElement>(null)
  const scrollerRef = useRef<HTMLDivElement>(null)
  const hover = useHoverIntent()

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return rows
    return rows.filter(chat => {
      const label = chatLabel(chat, sessionsById).toLowerCase()
      return label.includes(q)
    })
  }, [rows, query, sessionsById])

  useEffect(() => {
    if (selected >= filtered.length) setSelected(0)
  }, [filtered, selected])

  const setSelectedFromKeyboard = (n: number | ((s: number) => number)) => {
    hover.resetToKeyboard()
    setSelected(n)
  }
  const handleArrow = useArrowNav(filtered.length, setSelectedFromKeyboard)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])
  useLayoutEffect(() => {
    const scroller = scrollerRef.current
    const el = selectedRef.current
    if (scroller && el) ensureRowInView(scroller, el)
  }, [selected])

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault()
      onClose()
      return
    }
    if (handleArrow(e)) return
    if (e.key === "Enter") {
      e.preventDefault()
      const cmd = filtered[selected]
      if (cmd) onActivate(cmd)
    }
  }

  return (
    <PaletteShell
      header={
        <Input
          ref={inputRef}
          value={query}
          onChange={e => {
            setQuery(e.target.value)
            setSelected(0)
          }}
          onKeyDown={onKeyDown}
          placeholder="Find an agent…"
          spellCheck={false}
          className="w-full rounded-none border-0 bg-transparent px-3 py-2 text-[13px] shadow-none focus-visible:ring-0"
        />
      }
    >
      <div ref={scrollerRef} className="max-h-[360px] overflow-y-auto">
        {filtered.length === 0 ? (
          <div className="px-3 py-6 text-center text-[12px] text-muted-foreground">
            No agents in this scope.
          </div>
        ) : (
          filtered.map((chat, i) => (
            <AgentsMenuRow
              key={chat.id}
              chat={chat}
              session={
                chat.session.kind === "ready"
                  ? sessionsById[chat.session.sessionId]
                  : undefined
              }
              isSelected={i === selected}
              rowRef={i === selected ? selectedRef : null}
              onHover={() => {
                if (hover.isActive()) setSelected(i)
              }}
              onActivate={() => onActivate(chat)}
            />
          ))
        )}
      </div>
    </PaletteShell>
  )
}

function AgentsMenuRow({
  chat,
  session,
  isSelected,
  rowRef,
  onHover,
  onActivate,
}: {
  chat: Chat
  session: Session | undefined
  isSelected: boolean
  rowRef: React.Ref<HTMLButtonElement> | null
  onHover: () => void
  onActivate: () => void
}) {
  const sessionId =
    chat.session.kind === "ready" ? chat.session.sessionId : null
  const { label } = resolveChatLabel(chat, session)
  const fallbackLabel = chatLabel(chat, { [sessionId ?? ""]: session })

  return (
    <button
      ref={rowRef}
      type="button"
      onMouseDown={e => {
        e.preventDefault()
        onActivate()
      }}
      onMouseMove={onHover}
      className={cn(
        "flex h-auto w-full items-center justify-start gap-3 rounded-none border-0 bg-transparent px-3 py-1.5 text-left text-[13px] font-normal text-popover-foreground outline-none transition-none focus:outline-none",
        isSelected && "bg-accent text-accent-foreground",
      )}
    >
      <span className="truncate">{label || fallbackLabel}</span>
    </button>
  )
}
