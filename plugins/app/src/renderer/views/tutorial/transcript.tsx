import { useEffect, useMemo, useRef, useState } from "react"
import { Streamdown } from "streamdown"
import { streamdownProps } from "../../../../../chat/src/renderer/components/chat/lib/streamdown-config"
import { useAutoScroll } from "../../../../../chat/src/renderer/components/chat/lib/use-auto-scroll"
import { Loading } from "../../../../../chat/src/renderer/components/chat/messages/loading"
import zenbuLogoUrl from "./zenbu-logo.svg"
import {
  PI_PHRASE,
  QUESTION_PREFIX,
  WIDGET_PREFIX,
  type FakeMessage,
  type WidgetId,
} from "./types"
import { WidgetByName } from "./widgets"

/** Chat-like scrollable transcript: synthesized bubbles + the
 * "agent is typing" loader, mirroring the real chat's chrome. */
export function Transcript({
  messages,
  streaming,
  questionCard,
}: {
  messages: FakeMessage[]
  streaming: boolean
  questionCard: {
    phase: "loading" | "revealed"
    question: string
  } | null
}) {
  // Same auto-scroll the real chat uses (snap-to-bottom, pause on
  // scroll-up).
  const autoScroll = useAutoScroll({ working: streaming })

  // Fresh start timestamp on each streaming on-flip, to drive
  // `<Loading />`'s elapsed counter.
  const streamingStartRef = useRef<number | null>(null)
  const [streamingStart, setStreamingStart] = useState<number | null>(null)
  useEffect(() => {
    if (streaming) {
      if (streamingStartRef.current == null) {
        const now = Date.now()
        streamingStartRef.current = now
        setStreamingStart(now)
      }
    } else {
      streamingStartRef.current = null
      setStreamingStart(null)
    }
  }, [streaming])
  // Synthetic token count (words × ~1.3) so the footer reads like
  // the real chat's; the tutorial doesn't talk to a model.
  const streamingTokens = useMemo(() => {
    if (!streaming) return 0
    let words = 0
    for (const m of messages) {
      if (m.role !== "assistant") continue
      if (m.content.startsWith(WIDGET_PREFIX)) continue
      if (m.content.startsWith(QUESTION_PREFIX)) continue
      const matches = m.content.match(/\S+/g)
      if (matches) words += matches.length
    }
    return Math.round(words * 1.3)
  }, [streaming, messages])

  return (
    <div
      ref={autoScroll.scrollRef}
      onScroll={autoScroll.handleScroll}
      onClick={autoScroll.handleInteraction}
      className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6 pt-3 pb-1 [scrollbar-width:none]"
      style={{ overflowX: "hidden" }}
    >
      <div
        ref={autoScroll.contentRef}
        className="mx-auto w-full max-w-[919px] space-y-1.5"
      >
        {messages.map(msg =>
          msg.role === "user" ? (
            <UserBubble key={msg.key} content={msg.content} />
          ) : (
            <AssistantBubble key={msg.key} content={msg.content} />
          ),
        )}
        {questionCard ? (
          <AskQuestionCard
            phase={questionCard.phase}
            question={questionCard.question}
          />
        ) : null}
        {streaming ? (
          <Loading startTimestamp={streamingStart} tokens={streamingTokens} />
        ) : null}
        <div className="h-2" />
      </div>
    </div>
  )
}

/** Fake `ask_user_question` tool card. `loading` shimmers, then
 * `revealed` shows the question. Options render in the slot below. */
export function AskQuestionCard({
  phase,
  question,
}: {
  phase: "loading" | "revealed"
  question: string
}) {
  const loading = phase === "loading"
  return (
    <div className="max-w-[480px] py-1">
      <div className="overflow-hidden rounded-md border border-border bg-card/40">
        <header className="flex items-center gap-2 border-b border-border/60 px-3 py-1.5">
          <span
            className={
              "text-[11.5px] " +
              (loading ? "text-shimmer" : "text-muted-foreground")
            }
          >
            Ask user question
          </span>
        </header>
        <div className="min-h-[44px] px-3.5 py-3">
          {loading ? null : (
            <p className="text-[15px] font-medium leading-snug text-foreground">
              {question}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

function AssistantBubble({ content }: { content: string }) {
  if (content.startsWith(WIDGET_PREFIX)) {
    const id = content.slice(WIDGET_PREFIX.length) as WidgetId
    // No `px-3`: the widget card brings its own border.
    return (
      <div className="py-1">
        <WidgetByName id={id} />
      </div>
    )
  }
  if (content.startsWith(QUESTION_PREFIX)) {
    // Committed question card (snapshot, always revealed).
    const question = content.slice(QUESTION_PREFIX.length)
    return <AskQuestionCard phase="revealed" question={question} />
  }
  if (!content.trim()) return null
  // Append a pi-logo pill after the "pi coding agent" phrase.
  if (content.includes(PI_PHRASE)) {
    return (
      <div className="py-1">
        <div className="min-w-0 overflow-hidden px-3 leading-relaxed text-foreground">
          {renderWithPiPill(content)}
        </div>
      </div>
    )
  }
  // Splice a logo pill in place of the "Zenbu" wordmark.
  if (content.includes("Zenbu")) {
    return (
      <div className="py-1">
        <div className="min-w-0 overflow-hidden px-3 leading-relaxed text-foreground">
          {renderWithZenbuPill(content)}
        </div>
      </div>
    )
  }
  return (
    <div className="py-1">
      <div className="min-w-0 overflow-hidden px-3 leading-relaxed text-foreground">
        <Streamdown {...streamdownProps}>{content}</Streamdown>
      </div>
    </div>
  )
}

/** Renders text with a `<ZenbuPill />` in place of "Zenbu". */
function renderWithZenbuPill(content: string): React.ReactNode {
  const parts = content.split("Zenbu")
  const out: React.ReactNode[] = []
  parts.forEach((part, i) => {
    if (i > 0) out.push(<ZenbuPill key={`pill-${i}`} />)
    if (part) out.push(<span key={`txt-${i}`}>{part}</span>)
  })
  return out
}

/** Inline pill with the Zenbu wordmark (white bg across themes). */
function ZenbuPill() {
  return (
    <span
      className="mx-0.5 inline-flex items-center rounded-full bg-white px-2 py-[3px] align-middle"
      style={{
        boxShadow: "inset 0 0 0 1px rgba(0, 0, 0, 0.06)",
        transform: "translateY(-1px)",
      }}
    >
      <img
        src={zenbuLogoUrl}
        alt="Zenbu"
        className="h-3 w-auto select-none"
        draggable={false}
      />
    </span>
  )
}

/** Renders text with the `PI_PHRASE` bolded + a trailing `<PiPill />`. */
function renderWithPiPill(content: string): React.ReactNode {
  const parts = content.split(PI_PHRASE)
  const out: React.ReactNode[] = []
  parts.forEach((part, i) => {
    if (i > 0) {
      out.push(
        <span key={`piphr-${i}`} className="font-semibold text-foreground">
          {PI_PHRASE}
        </span>,
      )
      // Non-breaking space so the pill never wraps off "agent".
      out.push(<span key={`pinbsp-${i}`}>{"\u00A0"}</span>)
      out.push(<PiPill key={`pipill-${i}`} />)
    }
    if (part) out.push(<span key={`pitxt-${i}`}>{part}</span>)
  })
  return out
}

/** Inline pill with the pi mark (white-on-near-black, theme-stable). */
function PiPill() {
  return (
    <span
      className="mx-0.5 inline-flex items-center rounded-full bg-zinc-900 px-1.5 py-[3px] align-middle text-white"
      style={{
        boxShadow: "inset 0 0 0 1px rgba(255, 255, 255, 0.08)",
        transform: "translateY(-1px)",
      }}
    >
      <svg
        viewBox="0 0 800 800"
        aria-label="pi"
        role="img"
        className="h-[12px] w-[12px] fill-current"
      >
        <path
          fillRule="evenodd"
          d="M165.29 165.29 H517.36 V400 H400 V517.36 H282.65 V634.72 H165.29 Z M282.65 282.65 V400 H400 V282.65 Z"
        />
        <path d="M517.36 400 H634.72 V634.72 H517.36 Z" />
      </svg>
    </span>
  )
}

function UserBubble({ content }: { content: string }) {
  // Matches the real `UserMessage` chrome.
  return (
    <div className="py-1">
      <div
        className="w-full overflow-hidden rounded-md border border-border bg-accent text-accent-foreground"
        style={{ boxShadow: "0 1px 2px rgba(0, 0, 0, 0.03)" }}
      >
        <div className="px-3 py-2 text-[14px] leading-relaxed">{content}</div>
      </div>
    </div>
  )
}
