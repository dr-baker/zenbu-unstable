import { describe, expect, it } from "vitest"
import {
  runtimeCommandRowsForPayload,
  runtimeCommandRowsMatch,
} from "../lib/runtime-command-rows"
import type { RuntimeCommandsPayload } from "../../protocol"

function payload(commands: RuntimeCommandsPayload["commands"]): RuntimeCommandsPayload {
  return { sessionId: "session-a", commands }
}

describe("runtime command row sync helpers", () => {
  it("recognizes unchanged runtime command rows", () => {
    const next = runtimeCommandRowsForPayload(
      payload([
        {
          name: "review",
          description: "review changes",
          source: "extension",
          sourceInfo: { path: "a", nested: { b: 1 } },
        },
        { name: "skill:test", source: "skill" },
      ]),
    )

    expect(
      runtimeCommandRowsMatch(
        {
          [next[1]!.id]: next[1],
          [next[0]!.id]: {
            ...next[0]!,
            // Key order should not force rewrites for JSON-like metadata.
            sourceInfo: { nested: { b: 1 }, path: "a" },
          },
          "other:extension:review:0": {
            ...next[0]!,
            id: "other:extension:review:0",
            sessionId: "other",
          },
        },
        "session-a",
        next,
      ),
    ).toBe(true)
  })

  it("recognizes logically identical command catalogs in different orders", () => {
    const first = runtimeCommandRowsForPayload(
      payload([
        { name: "zeta", source: "skill", sourceInfo: { path: "z" } },
        { name: "alpha", source: "extension", sourceInfo: { path: "a" } },
        { name: "beta", source: "prompt", sourceInfo: { path: "b" } },
      ]),
    )
    const reordered = runtimeCommandRowsForPayload(
      payload([
        { name: "beta", source: "prompt", sourceInfo: { path: "b" } },
        { name: "alpha", source: "extension", sourceInfo: { path: "a" } },
        { name: "zeta", source: "skill", sourceInfo: { path: "z" } },
      ]),
    )

    expect(reordered.map(row => row.id)).toEqual(first.map(row => row.id))
    expect(
      runtimeCommandRowsMatch(
        Object.fromEntries(first.map(row => [row.id, row])),
        "session-a",
        reordered,
      ),
    ).toBe(true)
  })

  it("keeps row IDs stable when another command moves its sorted index", () => {
    const first = runtimeCommandRowsForPayload(
      payload([
        { name: "clear", source: "extension", sourceInfo: { path: "clear.ts" } },
        { name: "cmt", source: "extension", sourceInfo: { path: "cmt.ts" } },
      ]),
    )
    const withInsertedEarlierCommand = runtimeCommandRowsForPayload(
      payload([
        { name: "/", source: "extension", sourceInfo: { path: "slash.ts" } },
        { name: "clear", source: "extension", sourceInfo: { path: "clear.ts" } },
        { name: "cmt", source: "extension", sourceInfo: { path: "cmt.ts" } },
      ]),
    )

    const clearBefore = first.find(row => row.name === "clear")!
    const cmtBefore = first.find(row => row.name === "cmt")!
    expect(withInsertedEarlierCommand.find(row => row.name === "clear")?.id).toBe(
      clearBefore.id,
    )
    expect(withInsertedEarlierCommand.find(row => row.name === "cmt")?.id).toBe(
      cmtBefore.id,
    )
  })

  it("detects changed runtime command metadata", () => {
    const next = runtimeCommandRowsForPayload(
      payload([{ name: "review", description: "review changes", source: "extension" }]),
    )

    expect(
      runtimeCommandRowsMatch(
        {
          [next[0]!.id]: { ...next[0]!, description: "old description" },
        },
        "session-a",
        next,
      ),
    ).toBe(false)
  })
})
