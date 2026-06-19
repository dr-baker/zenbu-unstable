import { StrictMode, useMemo } from "react"
import { createRoot } from "react-dom/client"
import { useDb, useRegisterInjection, ZenbuProvider } from "@zenbujs/core/react"
import { skillPillExtension } from "../extension/skill-pill-extension"

type RuntimeCommand = {
  name: string
  source: "extension" | "prompt" | "skill"
}

type RootLike = {
  app?: {
    windowStates?: Record<string, any>
    chats?: Record<string, any>
  }
  pi?: {
    sessionRuntimeSnapshots?: Record<string, {
      capabilities?: { commands?: RuntimeCommand[] }
    }>
  }
}

function Registrar() {
  // The selector must return a value that `useDb`'s shallowEqual
  // snapshot cache can stabilize. Returning `{ skillNames, promptNames }`
  // with freshly-built arrays defeats the cache (nested arrays compare
  // by identity), which makes getSnapshot return a new value on every
  // db notification — an infinite useSyncExternalStore re-render loop
  // that can lock up the whole window while an agent is streaming.
  // Select a single joined string instead and split it in useMemo.
  const commandNamesKey = useDb(root => {
    const skillNames: string[] = []
    const promptNames: string[] = []
    const sessionId = resolveActiveSessionId(root as RootLike)
    const commands = sessionId
      ? root.pi.sessionRuntimeSnapshots[sessionId]?.capabilities.commands ?? []
      : []
    for (const runtimeCommand of commands as RuntimeCommand[]) {
      if (runtimeCommand.source === "skill") skillNames.push(runtimeCommand.name)
      else if (runtimeCommand.source === "prompt") promptNames.push(runtimeCommand.name)
    }
    return `${skillNames.sort().join("\0")}${promptNames.sort().join("\0")}`
  })
  const extension = useMemo(() => {
    const [skillPart = "", promptPart = ""] = commandNamesKey.split("")
    return skillPillExtension({
      skillNames: skillPart === "" ? [] : skillPart.split("\0"),
      promptNames: promptPart === "" ? [] : promptPart.split("\0"),
    })
  }, [commandNamesKey])

  useRegisterInjection(
    "skill-pills.skill-prompt-pill",
    extension,
    { kind: "cm.composer-extension", label: "Skill prompt pills" },
  )
  return null
}

function resolveActiveSessionId(root: RootLike): string | null {
  const windows = Object.values(root.app?.windowStates ?? {})
  for (const ws of windows) {
    if (!ws || ws.activeView?.kind !== "workspace") continue
    const scopeId = ws.selectedScopeId
    const paneState = scopeId ? ws.scopePanes?.[scopeId] : null
    const chatId = resolveChatIdFromPaneState(paneState)
    if (!chatId) continue
    const chat = root.app?.chats?.[chatId]
    if (chat?.session?.kind === "ready") return chat.session.sessionId
  }
  return null
}

function resolveChatIdFromPaneState(paneState: any): string | null {
  if (!paneState) return null
  const activePane =
    paneState.panes?.find((p: any) => p.id === paneState.activePaneId) ??
    paneState.panes?.[0]
  const activeTab =
    activePane?.tabs?.find((t: any) => t.id === activePane.activeTabId) ??
    activePane?.tabs?.[0]
  if (activeTab?.content?.kind === "chat" && activeTab.content.chatId) {
    return activeTab.content.chatId
  }
  for (const pane of paneState.panes ?? []) {
    const tab =
      pane.tabs?.find((t: any) => t.id === pane.activeTabId) ?? pane.tabs?.[0]
    if (tab?.content?.kind === "chat" && tab.content.chatId) {
      return tab.content.chatId
    }
  }
  return null
}

function mount() {
  if (document.body?.dataset.skillPillsMounted === "1") return
  if (document.body) document.body.dataset.skillPillsMounted = "1"

  const host = document.createElement("div")
  host.setAttribute("data-skill-pills", "1")
  host.style.display = "none"
  document.body.appendChild(host)

  createRoot(host).render(
    <StrictMode>
      <ZenbuProvider>
        <Registrar />
      </ZenbuProvider>
    </StrictMode>,
  )
}

mount()
