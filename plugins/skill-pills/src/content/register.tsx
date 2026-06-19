import { StrictMode, useMemo } from "react"
import { createRoot } from "react-dom/client"
import { useDb, useRegisterInjection, ZenbuProvider } from "@zenbujs/core/react"
import { skillPillExtension } from "../extension/skill-pill-extension"

type RuntimeCommand = {
  name: string
  source: "extension" | "prompt" | "skill"
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
    for (const command of Object.values(root.pi.runtimeCommands ?? {})) {
      const runtimeCommand = command as RuntimeCommand
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
