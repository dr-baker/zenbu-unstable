import { describe, expect, it } from "vitest"
import { compactAgentEventForEventLogSync } from "./event-log-payloads"

describe("compactAgentEventForEventLogSync compaction events", () => {
  it("keeps compaction_start reason only", () => {
    const out = compactAgentEventForEventLogSync({
      type: "compaction_start",
      reason: "overflow",
    } as never)
    expect(out).toEqual({ type: "compaction_start", reason: "overflow" })
  })

  it("trims compaction_end to rendering fields", () => {
    const out = compactAgentEventForEventLogSync({
      type: "compaction_end",
      reason: "threshold",
      aborted: false,
      willRetry: true,
      errorMessage: "nope",
      result: {
        summary: "summary text",
        firstKeptEntryId: "keep-1",
        tokensBefore: 120_000,
        details: { readFiles: ["a.ts"], modifiedFiles: ["b.ts"] },
        extra: "drop-me",
      },
      extraTop: true,
    } as never)

    expect(out).toEqual({
      type: "compaction_end",
      reason: "threshold",
      aborted: false,
      willRetry: true,
      errorMessage: "nope",
      result: {
        summary: "summary text",
        firstKeptEntryId: "keep-1",
        tokensBefore: 120_000,
        details: { readFiles: ["a.ts"], modifiedFiles: ["b.ts"] },
      },
      dropped: ["result.extra", "extra"],
    })
  })
})
