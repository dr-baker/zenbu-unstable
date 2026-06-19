import {
  countMaterializedUserMessages,
  materializeMessages,
  type MaterializeEventItem,
} from "./materialize"
import type { MaterializedMessage } from "./materialized-message"

export type MaterializeOptions = Parameters<typeof materializeMessages>[1]

type EventItem = MaterializeEventItem

export type MaterializedMessageCacheKey = {
  sessionId: string | null
  collectionId: string | null
  directory?: string | null
  extraDirectories?: readonly string[]
  workspaceId?: string | null
  scopeId?: string | null
}

type MaterializedMessageCacheEntry = {
  stableKey: string
  eventShape: string
  eventsRef: readonly EventItem[] | null
  messages: MaterializedMessage[]
  approxBytes: number
}

type EventLogSegment = {
  index: number
  startIndex: number
  endIndex: number
  startSeq: number
  endSeq: number
  events: readonly EventItem[]
  eventShape: string
  baseUserMessageIndex: number
  userMessageCount: number
}

export type EventLogSegmentation = {
  stableSegments: EventLogSegment[]
  tailEvents: readonly EventItem[]
  tailStartIndex: number
  stableUserMessageCount: number
  safe: boolean
  fallbackReason?: string
}

export type SegmentedMaterializationResult = {
  messages: MaterializedMessage[]
  cacheHit: boolean
  eventShape: string
  strategy: "empty" | "stable-reveal" | "segmented" | "full-fallback"
  stableSegmentCount: number
  stableSegmentCacheHits: number
  tailEventCount: number
  fallbackReason?: string
}

const DEFAULT_MAX_BYTES = 24 * 1024 * 1024

export class MaterializedMessageMruCache {
  private readonly entries = new Map<string, MaterializedMessageCacheEntry>()
  private readonly stableReveals = new Map<string, MaterializedMessage[]>()
  private totalApproxBytes = 0

  constructor(private readonly maxBytes = DEFAULT_MAX_BYTES) {}

  get size(): number {
    return this.entries.size
  }

  get byteSize(): number {
    return this.totalApproxBytes
  }

  clear(): void {
    this.entries.clear()
    this.stableReveals.clear()
    this.totalApproxBytes = 0
  }

  peek(key: MaterializedMessageCacheKey): MaterializedMessage[] | null {
    return this.peekByStableKey(wholeCacheKey(key))
  }

  peekStableReveal(key: MaterializedMessageCacheKey): MaterializedMessage[] | null {
    const stableKey = stableRevealCacheKey(key)
    const messages = this.stableReveals.get(stableKey)
    if (!messages) return null
    this.stableReveals.delete(stableKey)
    this.stableReveals.set(stableKey, messages)
    return messages
  }

  getOrMaterialize(
    events: readonly EventItem[],
    key: MaterializedMessageCacheKey,
    materialize: () => MaterializedMessage[],
  ): { messages: MaterializedMessage[]; cacheHit: boolean; eventShape: string } {
    return this.getOrMaterializeByStableKey({
      stableKey: wholeCacheKey(key),
      eventShape: eventLogShape(events),
      eventsRef: events,
      materialize,
    })
  }

  getOrMaterializeSegment(
    segment: EventLogSegment,
    key: MaterializedMessageCacheKey,
    materialize: () => MaterializedMessage[],
  ): { messages: MaterializedMessage[]; cacheHit: boolean; eventShape: string } {
    return this.getOrMaterializeByStableKey({
      stableKey: segmentCacheKey(key, segment),
      eventShape: segment.eventShape,
      eventsRef: segment.events,
      materialize,
    })
  }

  putStableReveal(
    key: MaterializedMessageCacheKey,
    _eventShape: string,
    messages: MaterializedMessage[],
  ): void {
    const stableKey = stableRevealCacheKey(key)
    this.stableReveals.delete(stableKey)
    this.stableReveals.set(stableKey, messages)
    // Reveal snapshots are references to already cached stable segment
    // messages plus a small concatenating array. Keep them bounded by count
    // so empty-log remounts can reveal history without competing with the
    // segment byte budget or duplicating full chat payloads indefinitely.
    while (this.stableReveals.size > 50) {
      const oldest = this.stableReveals.keys().next().value as string | undefined
      if (!oldest) break
      this.stableReveals.delete(oldest)
    }
  }

  private getOrMaterializeByStableKey(args: {
    stableKey: string
    eventShape: string
    eventsRef: readonly EventItem[] | null
    materialize: () => MaterializedMessage[]
  }): { messages: MaterializedMessage[]; cacheHit: boolean; eventShape: string } {
    const existing = this.entries.get(args.stableKey)
    if (
      existing &&
      existing.eventShape === args.eventShape &&
      (existing.eventsRef === args.eventsRef || existing.eventsRef !== null)
    ) {
      this.touch(args.stableKey, existing)
      return { messages: existing.messages, cacheHit: true, eventShape: args.eventShape }
    }

    const messages = args.materialize()
    this.putByStableKey({
      stableKey: args.stableKey,
      eventShape: args.eventShape,
      eventsRef: args.eventsRef,
      messages,
    })
    return { messages, cacheHit: false, eventShape: args.eventShape }
  }

  private putByStableKey(args: {
    stableKey: string
    eventShape: string
    eventsRef: readonly EventItem[] | null
    messages: MaterializedMessage[]
  }): void {
    const approxBytes = estimateMaterializedMessagesBytes(args.messages)
    const previous = this.entries.get(args.stableKey)
    if (previous) {
      this.entries.delete(args.stableKey)
      this.totalApproxBytes -= previous.approxBytes
    }
    this.entries.set(args.stableKey, {
      stableKey: args.stableKey,
      eventShape: args.eventShape,
      eventsRef: args.eventsRef,
      messages: args.messages,
      approxBytes,
    })
    this.totalApproxBytes += approxBytes
    this.trim()
  }

  private peekByStableKey(stableKey: string): MaterializedMessage[] | null {
    const entry = this.entries.get(stableKey)
    if (!entry) return null
    this.touch(stableKey, entry)
    return entry.messages
  }

  private touch(stableKey: string, entry: MaterializedMessageCacheEntry): void {
    this.entries.delete(stableKey)
    this.entries.set(stableKey, entry)
  }

  private trim(): void {
    // Keep at least the newest entry even if one very large chat/turn exceeds
    // the budget by itself; otherwise a single huge turn would never get a
    // cached reveal.
    while (this.totalApproxBytes > this.maxBytes && this.entries.size > 1) {
      const oldest = this.entries.keys().next().value as string | undefined
      if (!oldest) return
      const entry = this.entries.get(oldest)
      this.entries.delete(oldest)
      if (entry) this.totalApproxBytes -= entry.approxBytes
    }
  }
}

export const chatMaterializedMessageCache = new MaterializedMessageMruCache()

export function getCachedMaterializedMessages(
  events: readonly EventItem[],
  key: MaterializedMessageCacheKey,
  cache: MaterializedMessageMruCache = chatMaterializedMessageCache,
): { messages: MaterializedMessage[]; cacheHit: boolean; eventShape: string } {
  const options = materializeOptionsFromKey(key)
  return cache.getOrMaterialize(events, key, () =>
    materializeMessages(events as EventItem[], options),
  )
}

export function getCachedSegmentedMaterializedMessages(
  events: readonly EventItem[],
  key: MaterializedMessageCacheKey,
  cache: MaterializedMessageMruCache = chatMaterializedMessageCache,
): SegmentedMaterializationResult {
  const eventShape = eventLogShape(events)
  if (events.length === 0) {
    const cachedStable = cache.peekStableReveal(key) ?? cache.peek(key)
    if (cachedStable) {
      return {
        messages: cachedStable,
        cacheHit: true,
        eventShape,
        strategy: "stable-reveal",
        stableSegmentCount: 0,
        stableSegmentCacheHits: 0,
        tailEventCount: 0,
      }
    }
    return {
      messages: [],
      cacheHit: false,
      eventShape,
      strategy: "empty",
      stableSegmentCount: 0,
      stableSegmentCacheHits: 0,
      tailEventCount: 0,
    }
  }

  const options = materializeOptionsFromKey(key)
  try {
    const segmentation = segmentEventLogForMaterialization(events)
    if (!segmentation.safe) {
      return fullFallback(events, key, cache, segmentation.fallbackReason ?? "unsafe segmentation")
    }

    const stableMessages: MaterializedMessage[] = []
    let stableSegmentCacheHits = 0
    for (const segment of segmentation.stableSegments) {
      const materialized = cache.getOrMaterializeSegment(segment, key, () =>
        materializeMessages(segment.events as EventItem[], {
          ...options,
          initialUserMessageIndex: segment.baseUserMessageIndex,
        }),
      )
      if (materialized.cacheHit) stableSegmentCacheHits++
      stableMessages.push(...materialized.messages)
    }

    const stablePrefixShape = stableSegmentsShape(segmentation.stableSegments)
    if (segmentation.stableSegments.length > 0) {
      cache.putStableReveal(key, stablePrefixShape, stableMessages.slice())
    }

    const tailMessages =
      segmentation.tailEvents.length > 0
        ? materializeMessages(segmentation.tailEvents as EventItem[], {
            ...options,
            initialUserMessageIndex: segmentation.stableUserMessageCount,
          })
        : []

    return {
      messages: [...stableMessages, ...tailMessages],
      cacheHit:
        segmentation.stableSegments.length > 0 &&
        stableSegmentCacheHits === segmentation.stableSegments.length,
      eventShape,
      strategy: "segmented",
      stableSegmentCount: segmentation.stableSegments.length,
      stableSegmentCacheHits,
      tailEventCount: segmentation.tailEvents.length,
    }
  } catch (err) {
    return fullFallback(events, key, cache, traceError(err))
  }
}

export function peekCachedMaterializedMessages(
  key: MaterializedMessageCacheKey,
): MaterializedMessage[] | null {
  return chatMaterializedMessageCache.peek(key)
}

export function peekCachedSegmentedMaterializedMessages(
  key: MaterializedMessageCacheKey,
): MaterializedMessage[] | null {
  return (
    chatMaterializedMessageCache.peekStableReveal(key) ??
    chatMaterializedMessageCache.peek(key)
  )
}

export function segmentEventLogForMaterialization(
  events: readonly EventItem[],
): EventLogSegmentation {
  if (events.length === 0) {
    return {
      stableSegments: [],
      tailEvents: [],
      tailStartIndex: 0,
      stableUserMessageCount: 0,
      safe: true,
    }
  }

  const stableSegments: EventLogSegment[] = []
  let segmentStart = 0
  let stableUserMessageCount = 0
  let openAssistantMessages = 0
  const openToolCalls = new Set<string>()
  let openCompaction = false

  for (let i = 0; i < events.length; i++) {
    const event = events[i]!
    switch (event.kind) {
      case "message_start": {
        const payload = event.payload as { message?: { role?: string } } | undefined
        if (payload?.message?.role === "assistant") openAssistantMessages++
        break
      }
      case "message_end":
        if (openAssistantMessages > 0) openAssistantMessages--
        break
      case "tool_execution_start": {
        const payload = event.payload as { toolCallId?: string } | undefined
        openToolCalls.add(payload?.toolCallId ?? `tool-${event.seq}`)
        break
      }
      case "tool_execution_end": {
        const payload = event.payload as { toolCallId?: string } | undefined
        if (payload?.toolCallId) openToolCalls.delete(payload.toolCallId)
        break
      }
      case "compaction_start":
        openCompaction = true
        break
      case "compaction_end":
      case "compaction_summary":
        openCompaction = false
        break
      case "agent_end":
        if (
          openAssistantMessages === 0 &&
          openToolCalls.size === 0 &&
          !openCompaction &&
          i >= segmentStart
        ) {
          const segmentEvents = events.slice(segmentStart, i + 1)
          const userMessageCount = countMaterializedUserMessages(segmentEvents)
          stableSegments.push({
            index: stableSegments.length,
            startIndex: segmentStart,
            endIndex: i,
            startSeq: segmentEvents[0]?.seq ?? event.seq,
            endSeq: event.seq,
            events: segmentEvents,
            eventShape: eventLogShape(segmentEvents),
            baseUserMessageIndex: stableUserMessageCount,
            userMessageCount,
          })
          stableUserMessageCount += userMessageCount
          segmentStart = i + 1
        }
        break
      default:
        break
    }
  }

  return {
    stableSegments,
    tailEvents: events.slice(segmentStart),
    tailStartIndex: segmentStart,
    stableUserMessageCount,
    safe: true,
  }
}

export function stableCacheKey(key: MaterializedMessageCacheKey): string {
  return JSON.stringify({
    sessionId: key.sessionId ?? null,
    collectionId: key.collectionId ?? null,
    directory: key.directory ?? null,
    extraDirectories: [...(key.extraDirectories ?? [])],
    workspaceId: key.workspaceId ?? null,
    scopeId: key.scopeId ?? null,
  })
}

export function eventLogShape(events: readonly EventItem[]): string {
  const len = events.length
  if (len === 0) return "0"
  const first = events[0]!
  const last = events[len - 1]!
  let seqHash = 2166136261
  let kindHash = 2166136261
  let payloadHash = 2166136261
  for (const event of events) {
    seqHash = fnv1aInt(seqHash, event.seq)
    seqHash = fnv1aInt(seqHash, event.timestamp)
    kindHash = fnv1aString(kindHash, event.kind)
    payloadHash = fnv1aString(payloadHash, stableStringify(event.payload))
  }
  return [
    len,
    first.seq,
    first.kind,
    first.timestamp,
    last.seq,
    last.kind,
    last.timestamp,
    seqHash >>> 0,
    kindHash >>> 0,
    payloadHash >>> 0,
  ].join(":")
}

function fullFallback(
  events: readonly EventItem[],
  key: MaterializedMessageCacheKey,
  cache: MaterializedMessageMruCache,
  fallbackReason: string,
): SegmentedMaterializationResult {
  const materialized = getCachedMaterializedMessages(events, key, cache)
  return {
    messages: materialized.messages,
    cacheHit: materialized.cacheHit,
    eventShape: materialized.eventShape,
    strategy: "full-fallback",
    stableSegmentCount: 0,
    stableSegmentCacheHits: 0,
    tailEventCount: events.length,
    fallbackReason,
  }
}

function wholeCacheKey(key: MaterializedMessageCacheKey): string {
  return `whole:${stableCacheKey(key)}`
}

function stableRevealCacheKey(key: MaterializedMessageCacheKey): string {
  return `stable-reveal:${stableCacheKey(key)}`
}

function segmentCacheKey(
  key: MaterializedMessageCacheKey,
  segment: EventLogSegment,
): string {
  return `segment:${stableCacheKey(key)}:${segment.index}:${segment.startSeq}:${segment.endSeq}:u${segment.baseUserMessageIndex}`
}

function stableSegmentsShape(segments: readonly EventLogSegment[]): string {
  if (segments.length === 0) return "0"
  let hash = 2166136261
  for (const segment of segments) {
    hash = fnv1aInt(hash, segment.index)
    hash = fnv1aInt(hash, segment.startSeq)
    hash = fnv1aInt(hash, segment.endSeq)
    hash = fnv1aInt(hash, segment.baseUserMessageIndex)
    hash = fnv1aString(hash, segment.eventShape)
  }
  return `${segments.length}:${hash >>> 0}`
}

function materializeOptionsFromKey(key: MaterializedMessageCacheKey): MaterializeOptions {
  return {
    directory: key.directory ?? null,
    extraDirectories: key.extraDirectories ?? [],
    workspaceId: key.workspaceId ?? null,
    scopeId: key.scopeId ?? null,
  }
}

export function estimateMaterializedMessagesBytes(
  messages: readonly MaterializedMessage[],
): number {
  return estimateValueBytes(messages)
}

function estimateValueBytes(value: unknown, seen = new WeakSet<object>()): number {
  if (value == null) return 4
  switch (typeof value) {
    case "string":
      return 24 + value.length * 2
    case "number":
      return 8
    case "boolean":
      return 4
    case "bigint":
      return 8
    case "undefined":
    case "function":
    case "symbol":
      return 0
    case "object":
      break
  }

  const objectValue = value as Record<string, unknown>
  if (seen.has(objectValue)) return 0
  seen.add(objectValue)

  if (Array.isArray(value)) {
    let bytes = 24 + value.length * 8
    for (const item of value) bytes += estimateValueBytes(item, seen)
    return bytes
  }

  let bytes = 32
  for (const [key, child] of Object.entries(objectValue)) {
    bytes += 24 + key.length * 2
    bytes += estimateValueBytes(child, seen)
  }
  return bytes
}

function stableStringify(value: unknown, seen = new WeakSet<object>()): string {
  if (value == null) return String(value)
  switch (typeof value) {
    case "string":
      return JSON.stringify(value)
    case "number":
    case "boolean":
    case "bigint":
      return String(value)
    case "undefined":
      return "undefined"
    case "function":
      return "function"
    case "symbol":
      return value.toString()
    case "object":
      break
  }

  const objectValue = value as Record<string, unknown>
  if (seen.has(objectValue)) return '"[Circular]"'
  seen.add(objectValue)

  if (Array.isArray(value)) {
    return `[${value.map(item => stableStringify(item, seen)).join(",")}]`
  }

  return `{${Object.keys(objectValue)
    .sort()
    .map(childKey => `${JSON.stringify(childKey)}:${stableStringify(objectValue[childKey], seen)}`)
    .join(",")}}`
}

function fnv1aString(seed: number, value: string): number {
  let hash = seed >>> 0
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function fnv1aInt(seed: number, value: number): number {
  let hash = seed >>> 0
  hash ^= value >>> 0
  hash = Math.imul(hash, 16777619)
  hash ^= Math.floor(value / 0x100000000) >>> 0
  hash = Math.imul(hash, 16777619)
  return hash >>> 0
}

function traceError(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}
