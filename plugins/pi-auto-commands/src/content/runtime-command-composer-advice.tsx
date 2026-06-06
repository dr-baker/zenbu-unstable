import type { ComponentType } from "react"
import { useMemo } from "react"
import { useDb, useRpc } from "@zenbujs/core/react"

const ACTION_PREFIX = "pi-runtime:"

type SlashCommand = {
  id: string
  label: string
  description?: string
  group?: string
  hint?: string
  action?: string
  insertText?: string
  submitWith?: "steer" | "followUp"
}

type ComposerPropsWithSlashCommands = {
  composerId?: string
  slashCommands?: readonly SlashCommand[]
  onSlashAction?: (action: string) => void
}

type RuntimeCommand = {
  id: string
  sessionId: string
  name: string
  description?: string
  source: "extension" | "prompt" | "skill"
  sourceInfo?: unknown
}

type SourceInfoLike = {
  source?: string
  scope?: string
  origin?: string
}

export function RuntimeCommandComposerAdvice<P extends ComposerPropsWithSlashCommands>(
  Original: ComponentType<P>,
  props: P,
) {
  const rpc = useRpc()
  const composerId = props.composerId
  const sessionId = useDb(root => {
    if (!composerId) return null
    const chat = root.app.chats[composerId]
    return chat?.session.kind === "ready" ? chat.session.sessionId : null
  })
  const runtimeCommands = useDb(root => {
    if (!sessionId) return []
    return Object.values(root.pi.runtimeCommands).filter(
      (command): command is RuntimeCommand => command.sessionId === sessionId,
    )
  })

  const slashCommands = useMemo(() => {
    if (!sessionId || runtimeCommands.length === 0) {
      return props.slashCommands
    }
    const runtimeSlashCommands = runtimeCommands
      .sort(compareRuntimeCommands)
      .map(command => ({
        id: `pi-runtime:${command.id}`,
        label: command.name,
        description: command.description,
        group: groupForSource(command.source),
        hint: hintForCommand(command),
        action: `${ACTION_PREFIX}${encodeURIComponent(command.name)}`,
      }))
    return [...(props.slashCommands ?? []), ...runtimeSlashCommands]
  }, [props.slashCommands, runtimeCommands, sessionId])

  const onSlashAction = (action: string) => {
    if (action.startsWith(ACTION_PREFIX)) {
      if (!sessionId) return
      const name = decodeURIComponent(action.slice(ACTION_PREFIX.length))
      void rpc.app.sessions.runRuntimeCommand({ sessionId, text: `/${name}` })
      return
    }
    props.onSlashAction?.(action)
  }

  return (
    <Original
      {...props}
      slashCommands={slashCommands}
      onSlashAction={onSlashAction}
    />
  )
}

function compareRuntimeCommands(a: RuntimeCommand, b: RuntimeCommand): number {
  const source = sourceRank(a.source) - sourceRank(b.source)
  return source || a.name.localeCompare(b.name)
}

function sourceRank(source: RuntimeCommand["source"]): number {
  switch (source) {
    case "extension":
      return 0
    case "prompt":
      return 1
    case "skill":
      return 2
  }
}

function groupForSource(source: RuntimeCommand["source"]): string {
  switch (source) {
    case "extension":
      return "Pi Extensions"
    case "prompt":
      return "Pi Prompts"
    case "skill":
      return "Pi Skills"
  }
}

function hintForCommand(command: RuntimeCommand): string {
  const info = asSourceInfo(command.sourceInfo)
  const kind = command.source === "extension" ? "extension" : command.source
  const provenance = info?.origin === "package"
    ? "package"
    : info?.scope ?? info?.source ?? null
  return provenance ? `${kind} · ${provenance}` : kind
}

function asSourceInfo(value: unknown): SourceInfoLike | null {
  if (!value || typeof value !== "object") return null
  return value as SourceInfoLike
}
