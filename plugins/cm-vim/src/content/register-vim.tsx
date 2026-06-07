import { StrictMode, useMemo } from "react"
import { createRoot } from "react-dom/client"
import {
  useDb,
  useRegisterInjection,
  ZenbuProvider,
} from "@zenbujs/core/react"
import type { Extension } from "@codemirror/state"
import vimExtension from "../extension"
import { VimModeStatusItem } from "../components/vim-mode-status-item"

/**
 * FIXME: This is stupid, its mounting a react root just to access hooks
 * when these are available on the main process, do not reference
 * this code for future plugins
 */

const INJECTION_NAME = "cm-vim/vim"
const FLAG_ATTR = "data-cm-vim-mounted"

function VimRegistrar() {
  const enabled = useDb(root => root.app.settings.vimMode)
  // useRegisterInjection is reactive; when `enabled` flips, we
  // unregister + re-register with a different value. The empty
  // array (`[]`) is a valid no-op CodeMirror extension.
  const value = useMemo<Extension>(
    () => (enabled ? vimExtension : []),
    [enabled],
  )
  // Editable-only: a read-only user-message bubble has no use for
  // vim's fat cursor / modal keymaps. The host composer filters
  // this kind out when `readOnly` is true.
  useRegisterInjection(INJECTION_NAME, value, {
    kind: "cm.composer-extension-editable",
    label: "Vim mode",
  })
  // Status-bar item — same registry, different kind. The
  // The host's footer slot renders every injection tagged
  // `footer.item` (anchored to `position`, sorted by `order`).
  useRegisterInjection(
    "cm-vim/status-bar.vim-mode",
    VimModeStatusItem,
    {
      kind: "footer.item",
      label: "Vim mode",
      position: "right",
      order: 10,
    },
  )
  return null
}

function mount() {
  if (document.body?.dataset.cmVimMounted === "1") return
  if (document.body) document.body.dataset.cmVimMounted = "1"

  const host = document.createElement("div")
  host.setAttribute(FLAG_ATTR, "1")
  host.style.display = "none"
  document.body.appendChild(host)

  createRoot(host).render(
    <StrictMode>
      <ZenbuProvider>
        <VimRegistrar />
      </ZenbuProvider>
    </StrictMode>,
  )
}

mount()
