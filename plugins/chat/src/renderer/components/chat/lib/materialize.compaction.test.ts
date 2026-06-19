import { describe, expect, it } from "vitest"
import { materializeMessages } from "./materialize"

type EventItem = {
  seq: number
  kind: string
  payload: unknown
  timestamp: number
}

function compactionEvents(
  events: Array<{ kind: string; payload?: unknown; seq?: number }>,
): EventItem[] {
  let seq = 0
  return events.map(e => ({
    seq: e.seq ?? ++seq,
    kind: e.kind,
    payload: e.payload ?? {},
    timestamp: 1_700_000_000_000 + seq,
  }))
}

describe("materializeMessages compaction cards", () => {
  it("materializes a running card from compaction_start", () => {
    const out = materializeMessages(
      compactionEvents([{ kind: "compaction_start", payload: { reason: "manual" } }]),
    )
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      role: "compaction",
      status: "running",
      reason: "manual",
    })
  })

  it("promotes the running card to completed on compaction_end", () => {
    const out = materializeMessages(
      compactionEvents([
        { kind: "compaction_start", payload: { reason: "threshold" }, seq: 1 },
        {
          kind: "compaction_end",
          seq: 2,
          payload: {
            reason: "threshold",
            aborted: false,
            willRetry: false,
            result: {
              summary: "## Goal\nShip compaction cards",
              tokensBefore: 142_000,
              firstKeptEntryId: "entry-abc",
              details: { readFiles: ["a.ts"], modifiedFiles: ["b.ts"] },
            },
          },
        },
      ]),
    )

    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      role: "compaction",
      status: "completed",
      reason: "threshold",
      summary: "## Goal\nShip compaction cards",
      tokensBefore: 142_000,
      firstKeptEntryId: "entry-abc",
      readFiles: ["a.ts"],
      modifiedFiles: ["b.ts"],
    })
  })

  it("marks aborted compaction_end as canceled", () => {
    const out = materializeMessages(
      compactionEvents([
        { kind: "compaction_start", payload: { reason: "manual" }, seq: 1 },
        {
          kind: "compaction_end",
          seq: 2,
          payload: { reason: "manual", aborted: true, willRetry: false },
        },
      ]),
    )

    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      role: "compaction",
      status: "aborted",
    })
  })

  it("marks failed compaction_end with an error message", () => {
    const out = materializeMessages(
      compactionEvents([
        { kind: "compaction_start", payload: { reason: "overflow" }, seq: 1 },
        {
          kind: "compaction_end",
          seq: 2,
          payload: {
            reason: "overflow",
            aborted: false,
            willRetry: false,
            errorMessage: "Context overflow recovery failed: boom",
          },
        },
      ]),
    )

    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      role: "compaction",
      status: "failed",
      errorMessage: "Context overflow recovery failed: boom",
    })
  })

  it("materializes historical compaction_summary markers", () => {
    const out = materializeMessages(
      compactionEvents([
        {
          kind: "compaction_summary",
          payload: {
            summary: "## Goal\nEarlier work",
            tokensBefore: 88_000,
            firstKeptEntryId: "kept-entry",
            readFiles: ["read.ts"],
            modifiedFiles: ["modified.ts"],
          },
        },
      ]),
    )

    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      role: "compaction",
      status: "completed",
      historical: true,
      summary: "## Goal\nEarlier work",
      tokensBefore: 88_000,
      firstKeptEntryId: "kept-entry",
      readFiles: ["read.ts"],
      modifiedFiles: ["modified.ts"],
    })
  })

  it("does not leave a running card when only compaction_end is present", () => {
    const out = materializeMessages(
      compactionEvents([
        {
          kind: "compaction_end",
          payload: {
            reason: "manual",
            aborted: false,
            willRetry: false,
            result: {
              summary: "done",
              tokensBefore: 10,
              firstKeptEntryId: "x",
            },
          },
        },
      ]),
    )

    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ role: "compaction", status: "completed" })
  })
})
