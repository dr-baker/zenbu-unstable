import { describe, expect, it } from "vitest"
import { createFileEntryProvider, searchPathRows } from "./file-entry-provider"

describe("file entry provider", () => {
  it("returns bounded entries without requiring full entry materialization", () => {
    const out = searchPathRows(
      ["src/app.ts", "src/chat/chat-pane.tsx", "README.md"],
      "chatpane",
      5,
    )

    expect(out[0]).toEqual({ path: "src/chat/chat-pane.tsx", name: "chat-pane.tsx" })
  })

  it("bounds empty-query results", () => {
    const out = searchPathRows(
      ["a.ts", "b.ts", "c.ts"].map(path => ({ path })),
      "",
      2,
    )

    expect(out).toEqual([
      { path: "a.ts", name: "a.ts" },
      { path: "b.ts", name: "b.ts" },
    ])
  })

  it("builds and reuses a path set only when requested", () => {
    const provider = createFileEntryProvider(["src/app.ts", "src/ui/button.tsx"], "v1")
    const first = provider.getPathSet()
    const second = provider.getPathSet()

    expect(first).toBe(second)
    expect(first.has("src/ui/button.tsx")).toBe(true)
  })
})
