import { createHash } from "node:crypto"

import type { RuntimeCommandsPayload } from "../../protocol"

type RuntimeCommandSource = "extension" | "prompt" | "skill"

export type RuntimeCommandRow = {
  id: string
  sessionId: string
  name: string
  description?: string
  source: RuntimeCommandSource
  sourceInfo?: unknown
}

export function runtimeCommandRowsForPayload(
  payload: RuntimeCommandsPayload,
): RuntimeCommandRow[] {
  const occurrenceByKey = new Map<string, number>()
  return payload.commands
    .map((command, originalIndex) => ({ command, originalIndex }))
    .sort((a, b) => compareRuntimeCommands(a, b))
    .map(({ command }) => {
      const key = canonicalCommandKey(command)
      const occurrence = occurrenceByKey.get(key) ?? 0
      occurrenceByKey.set(key, occurrence + 1)
      return {
        id: runtimeCommandId(payload.sessionId, command, key, occurrence),
        sessionId: payload.sessionId,
        name: command.name,
        description: command.description,
        source: command.source,
        sourceInfo: command.sourceInfo,
      }
    })
}

export function runtimeCommandRowsMatch(
  existingRows: Record<string, RuntimeCommandRow | undefined>,
  sessionId: string,
  nextRows: readonly RuntimeCommandRow[],
): boolean {
  const existing = Object.values(existingRows)
    .filter((row): row is RuntimeCommandRow => row?.sessionId === sessionId)
    .sort((a, b) => a.id.localeCompare(b.id))
  if (existing.length !== nextRows.length) return false
  const expected = [...nextRows].sort((a, b) => a.id.localeCompare(b.id))
  for (let i = 0; i < expected.length; i++) {
    if (!runtimeCommandRowEqual(existing[i]!, expected[i]!)) return false
  }
  return true
}

function runtimeCommandRowEqual(a: RuntimeCommandRow, b: RuntimeCommandRow): boolean {
  return (
    a.id === b.id &&
    a.sessionId === b.sessionId &&
    a.name === b.name &&
    a.description === b.description &&
    a.source === b.source &&
    stableStringify(a.sourceInfo) === stableStringify(b.sourceInfo)
  )
}

function runtimeCommandId(
  sessionId: string,
  command: RuntimeCommandsPayload["commands"][number],
  key: string,
  occurrence: number,
): string {
  const hash = createHash("sha1").update(key).digest("base64url").slice(0, 12)
  const suffix = occurrence === 0 ? hash : `${hash}-${occurrence + 1}`
  return `${sessionId}:${command.source}:${encodeURIComponent(command.name)}:${suffix}`
}

function canonicalCommandKey(
  command: RuntimeCommandsPayload["commands"][number],
): string {
  return stableStringify({
    name: command.name,
    description: command.description ?? null,
    source: command.source,
    sourceInfo: command.sourceInfo ?? null,
  })
}

function compareRuntimeCommands(
  a: { command: RuntimeCommandsPayload["commands"][number]; originalIndex: number },
  b: { command: RuntimeCommandsPayload["commands"][number]; originalIndex: number },
): number {
  return (
    sourceRank(a.command.source) - sourceRank(b.command.source) ||
    a.command.name.localeCompare(b.command.name) ||
    (a.command.description ?? "").localeCompare(b.command.description ?? "") ||
    stableStringify(a.command.sourceInfo).localeCompare(stableStringify(b.command.sourceInfo)) ||
    a.originalIndex - b.originalIndex
  )
}

function sourceRank(source: RuntimeCommandSource): number {
  switch (source) {
    case "extension":
      return 0
    case "prompt":
      return 1
    case "skill":
      return 2
  }
}

function stableStringify(value: unknown): string {
  if (value === undefined) return "undefined"
  return JSON.stringify(sortJsonLike(value))
}

function sortJsonLike(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonLike)
  if (!value || typeof value !== "object") return value
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = sortJsonLike((value as Record<string, unknown>)[key])
  }
  return out
}
