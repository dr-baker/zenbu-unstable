import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useDbClient, useRpc } from "@zenbujs/core/react"
import { X } from "lucide-react"
import { newChatInCurrentPaneInRoot } from "../../lib/window-state/panes/splits"
import { useWindowId } from "../../lib/window-state/window-id"
import { LiveWidgetAckContext } from "./ack-context"
import {
  AFTER_WIDGET_MS,
  BEFORE_WIDGET_MS,
  BETWEEN_ITEM_MS,
  CHUNK_INTERVAL_MAX_MS,
  CHUNK_INTERVAL_MIN_MS,
  CHUNK_MAX_TOKENS,
  CHUNK_MIN_TOKENS,
  QUESTION_LOADING_MS,
  randInt,
} from "./constants"
import {
  clearOnboardingComplete,
  isOnboardingComplete,
  markOnboardingComplete,
} from "./onboarding-flag"
import { PostTutorialPlaceholder } from "./post-tutorial-placeholder"
import { QuestPrompt } from "./quest-prompt"
import { SCRIPT } from "./script"
import { Transcript } from "./transcript"
import { enableRecommendedPluginsNoSideEffects } from "./widgets/recommended-plugins"
import {
  QUESTION_PREFIX,
  WIDGET_PREFIX,
  type ChoicePrompt,
  type FakeMessage,
  type Node,
} from "./types"

/**
 * Tutorial view. Registered as a host view (`meta: { kind:
 * "view", label: "Tutorial" }`) and shipped as the default tab of
 * the playground workspace. Manufactures a chat (same padding,
 * bubbles, streaming indicator) driven by a local state machine —
 * no real session, no provider auth — so it can drive the host
 * (open palettes, spawn chats, deep-link to settings) and embed
 * widgets inline.
 */
export default function TutorialApp() {
  return (
    <div className="relative flex h-full min-h-0 w-full flex-col overflow-hidden bg-background">
      <TutorialBody />
    </div>
  )
}

function TutorialBody() {
  const rpc = useRpc()
  const dbClient = useDbClient()
  const windowId = useWindowId()
  const [nodeId, setNodeId] = useState<string>("intro")
  const [itemIdx, setItemIdx] = useState<number>(0)
  const [revealedWords, setRevealedWords] = useState<number>(0)
  const [completed, setCompleted] = useState<FakeMessage[]>([])
  const [questOpen, setQuestOpen] = useState<boolean>(false)
  const [visited, setVisited] = useState<Set<string>>(() => new Set())
  // Start already-exited (showing the placeholder, no replay) if
  // the user finished or skipped onboarding on a previous run.
  const [exited, setExited] = useState<boolean>(() => isOnboardingComplete())
  /** Question card lifecycle: `none` (streaming text) → `loading`
   * (card shimmering) → `revealed` (question + options shown). */
  const [questionPhase, setQuestionPhase] = useState<
    "none" | "loading" | "revealed"
  >("none")
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const currentNode: Node = SCRIPT[nodeId] ?? SCRIPT.intro
  const active = !exited

  // ---- streaming pump ----
  useEffect(() => {
    if (!active) return
    if (questOpen) return

    const item = currentNode.items[itemIdx]
    if (item == null) {
      // Items done — walk the question card through its phases.
      // `none`→`loading` flips without scheduling (the phase is
      // an effect dep, so it re-runs); `loading` schedules the
      // reveal timer; `revealed` opens the quest.
      if (questionPhase === "none") {
        setQuestionPhase("loading")
        return
      }
      if (questionPhase === "loading") {
        timerRef.current = setTimeout(
          () => setQuestionPhase("revealed"),
          QUESTION_LOADING_MS,
        )
        return () => {
          if (timerRef.current != null) clearTimeout(timerRef.current)
        }
      }
      // questionPhase === "revealed": open the quest.
      const next = currentNode.next({ visited })
      if ("kind" in next) {
        // Node with no quest is terminal — completes onboarding.
        markOnboardingComplete()
        timerRef.current = setTimeout(() => setExited(true), BETWEEN_ITEM_MS)
        return () => {
          if (timerRef.current != null) clearTimeout(timerRef.current)
        }
      }
      setQuestOpen(true)
      return
    }

    // Skip items whose condition is false (no render, no dwell).
    if (item.condition && !item.condition({ visited })) {
      setItemIdx(i => i + 1)
      setRevealedWords(0)
      return
    }

    if (item.kind === "widget") {
      // `awaitAck: true` widgets pause the pump indefinitely.
      // The widget renders in the in-flight branch of `messages`
      // and shows an "Okay, done!" button (via
      // `LiveWidgetAckContext`). The pump only advances when
      // the user clicks that button — see `ackWidget` below.
      if (item.awaitAck) return
      // Dwell on the widget before advancing.
      timerRef.current = setTimeout(() => {
        setCompleted(prev => [
          ...prev,
          {
            role: "assistant",
            content: WIDGET_PREFIX + item.widget,
            key: `${nodeId}:${itemIdx}`,
          },
        ])
        setItemIdx(i => i + 1)
        setRevealedWords(0)
      }, AFTER_WIDGET_MS)
      return () => {
        if (timerRef.current != null) clearTimeout(timerRef.current)
      }
    }

    // text item: reveal a randomized chunk per tick.
    const words = item.text.split(/(\s+)/)
    if (revealedWords >= words.length) {
      // Longer pause if a widget is next, so it doesn't snap in.
      const nextItem = currentNode.items[itemIdx + 1]
      const delayMs =
        nextItem?.kind === "widget" ? BEFORE_WIDGET_MS : BETWEEN_ITEM_MS
      timerRef.current = setTimeout(() => {
        setCompleted(prev => [
          ...prev,
          {
            role: "assistant",
            content: item.text,
            key: `${nodeId}:${itemIdx}`,
          },
        ])
        setItemIdx(i => i + 1)
        setRevealedWords(0)
      }, delayMs)
      return () => {
        if (timerRef.current != null) clearTimeout(timerRef.current)
      }
    }

    const chunk = randInt(CHUNK_MIN_TOKENS, CHUNK_MAX_TOKENS)
    const delay = randInt(CHUNK_INTERVAL_MIN_MS, CHUNK_INTERVAL_MAX_MS)
    timerRef.current = setTimeout(() => {
      setRevealedWords(w => Math.min(words.length, w + chunk))
    }, delay)
    return () => {
      if (timerRef.current != null) clearTimeout(timerRef.current)
    }
  }, [
    active,
    nodeId,
    itemIdx,
    revealedWords,
    currentNode,
    questOpen,
    questionPhase,
    visited,
  ])

  // ---- transcript (committed + in-flight) ----
  const messages = useMemo<FakeMessage[]>(() => {
    if (!active) return completed
    if (questOpen) return completed
    const item = currentNode.items[itemIdx]
    if (item == null) return completed
    if (item.condition && !item.condition({ visited })) return completed
    if (item.kind === "widget") {
      return [
        ...completed,
        {
          role: "assistant",
          content: WIDGET_PREFIX + item.widget,
          key: `${nodeId}:${itemIdx}`,
        },
      ]
    }
    const words = item.text.split(/(\s+)/)
    const sliced = words.slice(0, revealedWords).join("")
    if (sliced.length === 0) return completed
    return [
      ...completed,
      {
        role: "assistant",
        content: sliced,
        key: `${nodeId}:${itemIdx}`,
      },
    ]
  }, [
    active,
    completed,
    currentNode,
    itemIdx,
    revealedWords,
    questOpen,
    nodeId,
    visited,
  ])

  // ---- quest ----
  const quest = useMemo<ChoicePrompt | null>(() => {
    if (!active || !questOpen) return null
    const next = currentNode.next({ visited })
    if ("kind" in next) return null
    return next
  }, [active, questOpen, currentNode, visited])

  // ---- choice handler ----
  const pickOption = useCallback(
    (choiceId: string) => {
      if (!active || !questOpen) return
      const next = currentNode.next({ visited })
      if ("kind" in next) return
      const option = next.options.find(o => o.id === choiceId)
      if (!option) return

      // Terminal actions hand off to the host and complete
      // onboarding; they don't echo a bubble or advance the script.
      if (option.next === "openProject") {
        markOnboardingComplete()
        // Make sure the core sidebars are on even if the user never
        // toggled them in the recommended-plugins card. No reveal /
        // notice side effects — just enable, then open the palette.
        void (async () => {
          await enableRecommendedPluginsNoSideEffects(rpc)
          // RPC (not event) because renderer `events.*.emit` is a no-op.
          await rpc.openProjects.openProjects
            .togglePalette({ windowId })
            .catch(err =>
              console.error(
                "[tutorial] openProjects.togglePalette failed:",
                err,
              ),
            )
        })()
        return
      }
      if (option.next === "continueSandbox") {
        markOnboardingComplete()
        // Leaving onboarding: ensure the core sidebars are on (no
        // reveal / notice side effects).
        void enableRecommendedPluginsNoSideEffects(rpc)
        // New chat tab in the active pane (host's Cmd+T flow).
        void (async () => {
          // Wrapped in an object so TS doesn't narrow the
          // closure-assigned value to `never` after the await.
          const out: {
            value: { chatId: string; scopeId: string; paneId: string } | null
          } = { value: null }
          await dbClient.update(root => {
            out.value = newChatInCurrentPaneInRoot(
              root as Parameters<typeof newChatInCurrentPaneInRoot>[0],
              windowId,
            ) as typeof out.value
          })
          if (out.value) {
            try {
              await rpc.app.sessions.createChatSession({
                scopeId: out.value.scopeId,
                chatId: out.value.chatId,
              })
            } catch (err) {
              console.error("[tutorial] createChatSession failed:", err)
            }
          }
        })()
        return
      }

      // Navigation: commit the answered question card + the
      // user's choice as bubbles, then advance to the next node.
      setCompleted(prev => [
        ...prev,
        {
          role: "assistant",
          content: QUESTION_PREFIX + next.question,
          key: `${nodeId}:question`,
        },
        {
          role: "user",
          content: option.label,
          key: `${nodeId}:choice:${prev.length}`,
        },
      ])

      if (option.next === "exit") {
        markOnboardingComplete()
        setExited(true)
        return
      }
      // Mark current node visited so it drops from future quests.
      setVisited(prev => {
        if (prev.has(nodeId)) return prev
        const updated = new Set(prev)
        updated.add(nodeId)
        return updated
      })
      setNodeId(option.next)
      setItemIdx(0)
      setRevealedWords(0)
      setQuestOpen(false)
      setQuestionPhase("none")
    },
    [active, currentNode, dbClient, rpc, windowId, nodeId, visited, questOpen],
  )

  // The question card (loading shimmer / revealed question).
  const questionCard = useMemo(() => {
    if (questionPhase === "none") return null
    const next = currentNode.next({ visited })
    if ("kind" in next) return null
    return { phase: questionPhase, question: next.question }
  }, [questionPhase, currentNode, visited])

  // Ack handler for the live `awaitAck` widget: commit it and
  // advance the pump. Wired into `LiveWidgetAckContext`.
  const currentItem = currentNode.items[itemIdx]
  const ackingWidget =
    currentItem?.kind === "widget" &&
    currentItem.awaitAck === true &&
    !questOpen &&
    questionPhase === "none"

  // Streaming indicator: only while text is landing (not during
  // the question card or an awaiting-ack widget).
  const showStreamingIndicator =
    !questOpen && questionPhase === "none" && !ackingWidget
  const ackWidget = useCallback(() => {
    if (!ackingWidget) return
    const widget = currentItem?.kind === "widget" ? currentItem.widget : null
    if (!widget) return
    setCompleted(prev => [
      ...prev,
      {
        role: "assistant",
        content: WIDGET_PREFIX + widget,
        key: `${nodeId}:${itemIdx}`,
      },
    ])
    setItemIdx(i => i + 1)
    setRevealedWords(0)
  }, [ackingWidget, currentItem, nodeId, itemIdx])
  const liveAck = ackingWidget ? ackWidget : null

  // Jump to the skip-prompt node, clearing any in-flight timer.
  const skipTutorial = useCallback(() => {
    if (timerRef.current != null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    // Skipping still turns the core sidebars on (no side effects).
    void enableRecommendedPluginsNoSideEffects(rpc)
    setNodeId("skip-prompt")
    setItemIdx(0)
    setRevealedWords(0)
    setQuestOpen(false)
    setQuestionPhase("none")
  }, [rpc])

  const showSkipButton = !exited && nodeId !== "skip-prompt"

  // Replay onboarding from the top: clear the durable completion
  // flag and reset the whole state machine back to the intro.
  const restartTutorial = useCallback(() => {
    if (timerRef.current != null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    clearOnboardingComplete()
    setNodeId("intro")
    setItemIdx(0)
    setRevealedWords(0)
    setCompleted([])
    setQuestOpen(false)
    setVisited(new Set())
    setQuestionPhase("none")
    setExited(false)
  }, [])

  // ---- post-exit fallback ----
  if (!active) {
    return <PostTutorialPlaceholder onRedo={restartTutorial} />
  }

  return (
    <LiveWidgetAckContext.Provider value={liveAck}>
      <Transcript
        messages={messages}
        streaming={showStreamingIndicator}
        questionCard={questionCard}
      />
      {quest ? (
        <div className="px-6 pb-4">
          <div className="mx-auto w-full max-w-[919px] overflow-hidden rounded-lg border border-border/70 bg-card/40">
            <QuestPrompt options={quest.options} onPick={pickOption} />
          </div>
        </div>
      ) : (
        <div className="h-4 bg-background" />
      )}
      {showSkipButton ? (
        <footer className="flex shrink-0 items-center justify-start border-t border-border/60 bg-background px-3 py-1.5">
          <button
            type="button"
            onClick={skipTutorial}
            className="inline-flex items-center gap-1.5 rounded-md border border-border/70 bg-background px-2.5 py-1 text-[12px] font-medium text-foreground/85 hover:border-border hover:bg-accent/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          >
            Skip tutorial
            <X className="h-[12px] w-[12px]" strokeWidth={1.75} />
          </button>
        </footer>
      ) : null}
    </LiveWidgetAckContext.Provider>
  )
}
