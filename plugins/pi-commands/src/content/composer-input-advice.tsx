import type { ComponentType } from "react"
import { EditorView } from "@codemirror/view"
import type { Extension } from "@codemirror/state"
import { useDb, useRpc } from "@zenbujs/core/react"
import { TreeSelector } from "./components/tree-selector"
import { ForkSelector } from "./components/fork-selector"

/**
 * Around-advice on the host Composer.
 *
 *   1. Reads our own db section (`db.piCommands.panels[composerId]`)
 *      to decide whether to swap the input surface for a panel
 *      (info / tree / fork). The panel state is written by our
 *      slash-command RPC handlers; the host has no idea any of this
 *      is happening.
 *
 *   2. When no panel is active, appends a tiny CodeMirror extension
 *      to the composer that drops a data attribute on the editor
 *      DOM. Demo seam for future plugins.
 */

type ComposerPropsWithExtensions = {
  codeMirrorExtensions?: readonly Extension[]
  composerId?: string
}

// Note: pi-commands no longer reads `piCommandPanel` / `onPiCommandPanelClose`
// from props. The panel state lives in our own db section
// (`root.piCommands.panels[composerId]`) and is closed via the
// `closePanel` RPC. The host composer no longer carries those props.

const piCommandInputExtension = EditorView.domEventHandlers({
  focus(_event, view) {
    view.dom.dataset.piCommandsInput = "true"
    return false
  },
})

export function ComposerInputAdvice<P extends ComposerPropsWithExtensions>(
  Original: ComponentType<P>,
  props: P,
) {
  const composerId = props.composerId
  // No composerId = no addressable panel slot. Just pass through.
  const panel = useDb(root =>
    composerId ? root.piCommands?.panels?.[composerId] ?? null : null,
  )

  if (panel && composerId) {
    return <PiCommandPanelView panel={panel} composerId={composerId} />
  }

  const nextExtensions = [
    ...(props.codeMirrorExtensions ?? []),
    piCommandInputExtension,
  ]
  return <Original {...props} codeMirrorExtensions={nextExtensions} />
}

type Panel =
  | { kind: "info"; title: string; lines: string[] }
  | { kind: "tree"; sessionId: string; windowId: string }
  | { kind: "fork"; sessionId: string; windowId: string }

function PiCommandPanelView({
  panel,
  composerId,
}: {
  panel: Panel
  composerId: string
}) {
  const rpc = useRpc()
  const close = () =>
    void rpc.piCommands.piCommands.closePanel({ composerId })

  if (panel.kind === "info") {
    return <PiCommandInfoPanel panel={panel} onClose={close} />
  }
  return <PiTreeForkPanel panel={panel} onClose={close} />
}

function PiTreeForkPanel({
  panel,
  onClose,
}: {
  panel: Extract<Panel, { kind: "tree" } | { kind: "fork" }>
  onClose: () => void
}) {
  const rpc = useRpc()
  const session = useDb(root => root.pi.sessions[panel.sessionId])
  const refreshKey = session?.lastActivityAt ?? 0
  const activeLeafId = session?.currentLeafEntryId ?? null

  if (panel.kind === "tree") {
    return (
      <TreeSelector
        sessionId={panel.sessionId}
        refreshKey={refreshKey}
        activeLeafId={activeLeafId}
        onConfirm={async ({ entryId, choice }) => {
          try {
            await rpc.pi.sessions.navigateTree({
              sessionId: panel.sessionId,
              entryId,
              summarize: choice.kind !== "none",
              customInstructions:
                choice.kind === "custom" ? choice.customInstructions : undefined,
            })
          } finally {
            onClose()
          }
        }}
        onCancel={() => onClose()}
      />
    )
  }

  return (
    <ForkSelector
      sessionId={panel.sessionId}
      refreshKey={refreshKey}
      activeLeafId={activeLeafId}
      onConfirm={async ({ entryId }) => {
        try {
          await rpc.pi.sessions.forkAtUserMessage({
            sessionId: panel.sessionId,
            entryId,
            windowId: panel.windowId,
          })
        } finally {
          onClose()
        }
      }}
      onCancel={() => onClose()}
    />
  )
}

function PiCommandInfoPanel({
  panel,
  onClose,
}: {
  panel: Extract<Panel, { kind: "info" }>
  onClose: () => void
}) {
  return (
    <div
      style={{
        borderRadius: 10,
        border: "1px solid var(--border)",
        background: "var(--card)",
        color: "var(--foreground)",
        padding: "12px 14px",
        display: "flex",
        flexDirection: "column",
        gap: 10,
        boxShadow: "0 12px 30px rgba(0,0,0,0.16)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 650 }}>{panel.title}</div>
          <div style={{ marginTop: 2, fontSize: 11.5, opacity: 0.65 }}>
            Pi command result
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          style={{
            fontSize: 12,
            padding: "4px 10px",
            borderRadius: 6,
            border: "1px solid var(--border)",
            background: "var(--background)",
            color: "var(--foreground)",
            cursor: "pointer",
          }}
        >
          Close
        </button>
      </div>
      {panel.lines.length > 0 && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 4,
            fontSize: 12,
            fontFamily:
              "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
            opacity: 0.85,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {panel.lines.map((line, i) => (
            <div key={i}>{line}</div>
          ))}
        </div>
      )}
    </div>
  )
}
