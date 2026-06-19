import { describe, expect, it } from "vitest"
import {
  MaterializedMessageMruCache,
  estimateMaterializedMessagesBytes,
  eventLogShape,
  getCachedSegmentedMaterializedMessages,
  segmentEventLogForMaterialization,
  stableCacheKey,
} from "./materialized-message-cache"
import type { MaterializedMessage } from "./materialized-message"

type EventItem = {
  seq: number
  kind: string
  payload: unknown
  timestamp: number
}

const key = (sessionId: string, extra: Partial<Parameters<typeof stableCacheKey>[0]> = {}) => ({
  sessionId,
  collectionId: `collection-${sessionId}`,
  directory: "/repo",
  extraDirectories: [],
  workspaceId: "workspace",
  scopeId: "scope",
  ...extra,
})

const events = (...items: Array<Partial<EventItem>>): EventItem[] =>
  items.map((item, index) => ({
    seq: item.seq ?? index + 1,
    kind: item.kind ?? "user_prompt",
    payload: item.payload ?? { text: `event ${index}` },
    timestamp: item.timestamp ?? 1_000 + index,
  }))

const messages = (label: string): MaterializedMessage[] => [
  { role: "user", content: label, key: `user-${label}` },
]

const turn = (args: {
  seq: number
  prompt: string
  answer: string
  agentEnd?: boolean
}): EventItem[] => {
  const timestamp = 1_700_000_000_000 + args.seq
  const rows: EventItem[] = [
    {
      seq: args.seq,
      kind: "user_prompt",
      payload: { text: args.prompt },
      timestamp,
    },
    {
      seq: args.seq + 1,
      kind: "message_start",
      payload: { message: { role: "assistant" } },
      timestamp: timestamp + 1,
    },
    {
      seq: args.seq + 2,
      kind: "message_end",
      payload: {
        message: {
          role: "assistant",
          content: [{ type: "text", text: args.answer }],
        },
      },
      timestamp: timestamp + 2,
    },
  ]
  if (args.agentEnd !== false) {
    rows.push({
      seq: args.seq + 3,
      kind: "agent_end",
      payload: {},
      timestamp: timestamp + 3,
    })
  }
  return rows
}

const streamingTail = (args: {
  seq: number
  prompt: string
  partial: string
}): EventItem[] => {
  const timestamp = 1_700_000_000_000 + args.seq
  return [
    {
      seq: args.seq,
      kind: "user_prompt",
      payload: { text: args.prompt },
      timestamp,
    },
    {
      seq: args.seq + 1,
      kind: "message_start",
      payload: { message: { role: "assistant" } },
      timestamp: timestamp + 1,
    },
    {
      seq: args.seq + 2,
      kind: "message_update",
      payload: {
        assistantMessageEvent: {
          partial: {
            role: "assistant",
            content: [{ type: "text", text: args.partial }],
          },
        },
      },
      timestamp: timestamp + 2,
    },
  ]
}

describe("MaterializedMessageMruCache", () => {
  it("returns the previous materialized messages for an unchanged event shape", () => {
    const cache = new MaterializedMessageMruCache(100_000)
    const rows = events({ seq: 1 }, { seq: 2 })
    let calls = 0

    const first = cache.getOrMaterialize(rows, key("a"), () => {
      calls++
      return messages("first")
    })
    const second = cache.getOrMaterialize([...rows], key("a"), () => {
      calls++
      return messages("second")
    })

    expect(first.cacheHit).toBe(false)
    expect(second.cacheHit).toBe(true)
    expect(second.messages).toBe(first.messages)
    expect(calls).toBe(1)
  })

  it("misses when materialization inputs or event-log shape change", () => {
    const cache = new MaterializedMessageMruCache(100_000)
    const rows = events({ seq: 1 }, { seq: 2 })
    let calls = 0

    cache.getOrMaterialize(rows, key("a"), () => {
      calls++
      return messages("initial")
    })
    const inputChanged = cache.getOrMaterialize(
      rows,
      key("a", { workspaceId: "other-workspace" }),
      () => {
        calls++
        return messages("workspace")
      },
    )
    const eventsChanged = cache.getOrMaterialize(
      events({ seq: 1 }, { seq: 3, kind: "message_end" }),
      key("a"),
      () => {
        calls++
        return messages("events")
      },
    )

    expect(inputChanged.cacheHit).toBe(false)
    expect(eventsChanged.cacheHit).toBe(false)
    expect(calls).toBe(3)
  })

  it("misses when event payload shape changes without seq/kind changes", () => {
    const cache = new MaterializedMessageMruCache(100_000)
    const firstRows = events({
      seq: 1,
      kind: "user_prompt",
      payload: { text: "before" },
      timestamp: 1,
    })
    const secondRows = events({
      seq: 1,
      kind: "user_prompt",
      payload: { text: "after" },
      timestamp: 1,
    })
    let calls = 0

    cache.getOrMaterialize(firstRows, key("payload"), () => {
      calls++
      return messages("before")
    })
    const changed = cache.getOrMaterialize(secondRows, key("payload"), () => {
      calls++
      return messages("after")
    })

    expect(changed.cacheHit).toBe(false)
    expect(changed.messages).toEqual(messages("after"))
    expect(calls).toBe(2)
  })

  it("evicts least recently used entries when the byte budget is exceeded", () => {
    const entryBytes = estimateMaterializedMessagesBytes(messages("largest"))
    const cache = new MaterializedMessageMruCache(entryBytes * 2 + 100)
    const rows = events({ seq: 1 })

    cache.getOrMaterialize(rows, key("a"), () => messages("a"))
    cache.getOrMaterialize(rows, key("b"), () => messages("b"))
    cache.getOrMaterialize(rows, key("a"), () => messages("a2"))
    cache.getOrMaterialize(rows, key("c"), () => messages("c"))

    let calls = 0
    const a = cache.getOrMaterialize(rows, key("a"), () => {
      calls++
      return messages("a3")
    })
    const b = cache.getOrMaterialize(rows, key("b"), () => {
      calls++
      return messages("b2")
    })

    expect(a.cacheHit).toBe(true)
    expect(b.cacheHit).toBe(false)
    expect(calls).toBe(1)
    expect(cache.byteSize).toBeLessThanOrEqual(entryBytes * 2 + 100)
  })

  it("keeps the newest entry when a single chat is larger than the byte budget", () => {
    const cache = new MaterializedMessageMruCache(1)
    const rows = events({ seq: 1 })
    const largeMessages = messages("x".repeat(1_000))

    const first = cache.getOrMaterialize(rows, key("large"), () => largeMessages)
    const second = cache.getOrMaterialize(rows, key("large"), () => messages("miss"))

    expect(first.cacheHit).toBe(false)
    expect(second.cacheHit).toBe(true)
    expect(second.messages).toBe(largeMessages)
    expect(cache.size).toBe(1)
    expect(cache.byteSize).toBeGreaterThan(1)
  })

  it("includes history shape, not just last seq", () => {
    const left = eventLogShape(events({ seq: 1 }, { seq: 2 }, { seq: 3 }))
    const branched = eventLogShape(events({ seq: 1 }, { seq: 4 }, { seq: 3 }))

    expect(branched).not.toBe(left)
  })
})

describe("segmented chat materialization", () => {
  it("handles an empty event log without materializing", () => {
    const cache = new MaterializedMessageMruCache(100_000)
    const result = getCachedSegmentedMaterializedMessages([], key("empty"), cache)
    const segmentation = segmentEventLogForMaterialization([])

    expect(result).toMatchObject({
      messages: [],
      cacheHit: false,
      strategy: "empty",
      stableSegmentCount: 0,
      tailEventCount: 0,
    })
    expect(segmentation.stableSegments).toHaveLength(0)
    expect(segmentation.tailEvents).toHaveLength(0)
  })

  it("splits finalized turns from a live streaming tail and preserves user indexes", () => {
    const rows = [
      ...turn({ seq: 1, prompt: "first", answer: "done" }),
      ...streamingTail({ seq: 10, prompt: "second", partial: "working" }),
    ]
    const cache = new MaterializedMessageMruCache(100_000)

    const result = getCachedSegmentedMaterializedMessages(rows, key("tail"), cache)

    expect(result.strategy).toBe("segmented")
    expect(result.stableSegmentCount).toBe(1)
    expect(result.tailEventCount).toBe(3)
    expect(result.messages.map(message => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ])
    expect(result.messages[0]).toMatchObject({ role: "user", userMessageIndex: 0 })
    expect(result.messages[2]).toMatchObject({ role: "user", userMessageIndex: 1 })
    expect(result.messages[3]).toMatchObject({ role: "assistant", content: "working" })
  })

  it("renders a streaming tail even when no stable turn is cached yet", () => {
    const rows = streamingTail({ seq: 1, prompt: "first", partial: "typing" })
    const result = getCachedSegmentedMaterializedMessages(
      rows,
      key("only-tail"),
      new MaterializedMessageMruCache(100_000),
    )

    expect(result.strategy).toBe("segmented")
    expect(result.stableSegmentCount).toBe(0)
    expect(result.tailEventCount).toBe(3)
    expect(result.messages[0]).toMatchObject({ role: "user", userMessageIndex: 0 })
    expect(result.messages[1]).toMatchObject({ role: "assistant", content: "typing" })
  })

  it("reveals only cached stable turns while an empty remount waits for live events", () => {
    const cache = new MaterializedMessageMruCache(100_000)
    const cacheKey = key("reveal")
    getCachedSegmentedMaterializedMessages(
      [
        ...turn({ seq: 1, prompt: "stable", answer: "done" }),
        ...streamingTail({ seq: 10, prompt: "live", partial: "stale tail" }),
      ],
      cacheKey,
      cache,
    )

    const reveal = getCachedSegmentedMaterializedMessages([], cacheKey, cache)

    expect(reveal.strategy).toBe("stable-reveal")
    expect(reveal.messages.map(message => [message.role, "content" in message ? message.content : null])).toEqual([
      ["user", "stable"],
      ["assistant", "done"],
    ])
  })

  it("reuses cached stable turns while rematerializing streaming tails", () => {
    const cache = new MaterializedMessageMruCache(100_000)
    const stable = turn({ seq: 1, prompt: "first", answer: "done" })

    const first = getCachedSegmentedMaterializedMessages(
      [...stable, ...streamingTail({ seq: 10, prompt: "second", partial: "one" })],
      key("stream"),
      cache,
    )
    const second = getCachedSegmentedMaterializedMessages(
      [...stable, ...streamingTail({ seq: 10, prompt: "second", partial: "two" })],
      key("stream"),
      cache,
    )

    expect(first.stableSegmentCacheHits).toBe(0)
    expect(second.stableSegmentCacheHits).toBe(1)
    expect(second.cacheHit).toBe(true)
    expect(second.messages.at(-1)).toMatchObject({ role: "assistant", content: "two" })
  })

  it("renders a no-cache first load by materializing completed stable segments", () => {
    const cache = new MaterializedMessageMruCache(100_000)
    const rows = [
      ...turn({ seq: 1, prompt: "first", answer: "one" }),
      ...turn({ seq: 10, prompt: "second", answer: "two" }),
    ]

    const result = getCachedSegmentedMaterializedMessages(rows, key("first-load"), cache)

    expect(result.strategy).toBe("segmented")
    expect(result.cacheHit).toBe(false)
    expect(result.stableSegmentCount).toBe(2)
    expect(result.tailEventCount).toBe(0)
    expect(result.messages.map(message => [message.role, "content" in message ? message.content : null])).toEqual([
      ["user", "first"],
      ["assistant", "one"],
      ["user", "second"],
      ["assistant", "two"],
    ])
  })

  it("keeps the newest oversized completed turn segment", () => {
    const cache = new MaterializedMessageMruCache(1)
    const rows = turn({
      seq: 1,
      prompt: "huge",
      answer: "x".repeat(2_000),
    })

    const first = getCachedSegmentedMaterializedMessages(rows, key("huge"), cache)
    const second = getCachedSegmentedMaterializedMessages(rows, key("huge"), cache)

    expect(first.cacheHit).toBe(false)
    expect(second.cacheHit).toBe(true)
    expect(second.stableSegmentCacheHits).toBe(1)
    expect(cache.size).toBe(1)
    expect(cache.byteSize).toBeGreaterThan(1)
  })

  it("leaves completed-but-unterminated turns in the live tail instead of caching them as stable", () => {
    const rows = turn({
      seq: 1,
      prompt: "no agent end",
      answer: "not stable yet",
      agentEnd: false,
    })

    const segmentation = segmentEventLogForMaterialization(rows)
    const result = getCachedSegmentedMaterializedMessages(
      rows,
      key("unterminated"),
      new MaterializedMessageMruCache(100_000),
    )

    expect(segmentation.stableSegments).toHaveLength(0)
    expect(segmentation.tailEvents).toHaveLength(rows.length)
    expect(result.strategy).toBe("segmented")
    expect(result.stableSegmentCount).toBe(0)
    expect(result.messages.map(message => message.role)).toEqual(["user", "assistant"])
  })
})
