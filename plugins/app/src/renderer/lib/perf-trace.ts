type TracePhase = "i" | "X" | "s" | "f"

type JsonObject = Record<string, unknown>

export type PerfTraceEvent = {
  v: 1
  /** Chrome Trace Event phase. `X` spans use microsecond `dur`. */
  ph: TracePhase
  name: string
  cat: string
  /** Microseconds since `performance.timeOrigin`, Chrome Trace compatible. */
  ts: number
  /** Milliseconds since `performance.timeOrigin`, friendlier for agents. */
  tsMs: number
  wallTime: string
  pid: "renderer"
  tid: string
  id?: string
  flowId?: string
  s?: "t"
  dur?: number
  durMs?: number
  args?: JsonObject
}

export type PerfTraceDumpPayload = {
  reason: string
  trigger: "manual" | "auto"
  createdAt: string
  timeOrigin: number
  href: string
  events: PerfTraceEvent[]
}

export type PerfTraceDumpResult = {
  ok: boolean
  path?: string
  eventCount?: number
  bytes?: number
  error?: string
}

export type PerfTraceContext = {
  /** Stable key used to attach work in different components to one flow. */
  subjectKey: string
  source?: string
  visible?: boolean
  args?: JsonObject
}

type DumpWriter = (payload: PerfTraceDumpPayload) => Promise<PerfTraceDumpResult>

type FlowState = {
  id: string
  name: string
  subjectKey?: string
  args?: JsonObject
  startedAt: number
  lastProgressAt: number
  stalledTimer: number | null
}

type SpanHandle = {
  end: (args?: JsonObject) => void
}

type StartOptions = {
  subjectKey?: string
  args?: JsonObject
}

type RecordOptions = {
  flowId?: string
  subjectKey?: string | null
  args?: JsonObject
}

const RING_SIZE = 2_000
const SLOW_FLOW_MS = 500
const SLOW_SPAN_MS = 100
const STALLED_FLOW_MS = 2_000
const AUTO_DUMP_COOLDOWN_MS = 30_000
const MAX_AUTO_DUMPS = 5
const COMPLETED_FLOW_CORRELATION_MS = 10_000

let installed = false
let enabled = false
let writer: DumpWriter | null = null
let events: PerfTraceEvent[] = []
let droppedEvents = 0
let nextFlowSeq = 1
let nextSpanSeq = 1
let autoDumpCount = 0
let lastAutoDumpAt = 0
let lastDumpPath: string | null = null
let longTaskObserver: PerformanceObserver | null = null

const activeFlows = new Map<string, FlowState>()
const flowsBySubject = new Map<string, string>()
const completedFlowsBySubject = new Map<string, { flowId: string; expiresAt: number }>()

function readEnabledFlag(): boolean {
  if (typeof window === "undefined") return false
  try {
    const params = new URLSearchParams(window.location.search)
    const param = params.get("perfTrace")
    if (param === "1" || param === "true") return true
    if (param === "0" || param === "false") return false
    const stored = window.localStorage.getItem("zenbuPerfTrace")
    return stored === "1" || stored === "true"
  } catch {
    return false
  }
}

function nowMs(): number {
  return performance.now()
}

function toTraceTs(ms: number): number {
  return Math.round(ms * 1000)
}

function wallTimeFor(ms: number): string {
  return new Date(performance.timeOrigin + ms).toISOString()
}

function shortId(prefix: string, seq: number): string {
  return `${prefix}-${seq.toString(36)}`
}

function nativeName(name: string, id: string): string {
  return `zenbu.${name}.${id}`
}

function resolveFlowId(opts?: RecordOptions): string | undefined {
  if (opts?.flowId) return opts.flowId
  if (!opts?.subjectKey) return undefined
  const active = flowsBySubject.get(opts.subjectKey)
  if (active) return active
  const completed = completedFlowsBySubject.get(opts.subjectKey)
  if (!completed) return undefined
  if (completed.expiresAt < nowMs()) {
    completedFlowsBySubject.delete(opts.subjectKey)
    return undefined
  }
  return completed.flowId
}

function activeFlowForSubject(subjectKey: string | null | undefined): FlowState | null {
  if (!subjectKey) return null
  const flowId = flowsBySubject.get(subjectKey)
  return flowId ? activeFlows.get(flowId) ?? null : null
}

function touchFlow(flowId: string | undefined): void {
  if (!flowId) return
  const flow = activeFlows.get(flowId)
  if (!flow) return
  flow.lastProgressAt = nowMs()
  armStalledTimer(flow)
}

function pushEvent(event: PerfTraceEvent): void {
  if (!enabled) return
  events.push(event)
  if (events.length > RING_SIZE) {
    const dropped = events.length - RING_SIZE
    events = events.slice(dropped)
    droppedEvents += dropped
  }
  touchFlow(event.flowId)
}

function record(
  ph: TracePhase,
  cat: string,
  name: string,
  atMs: number,
  opts?: RecordOptions & { id?: string; durMs?: number; scope?: "t" },
): PerfTraceEvent | null {
  if (!enabled) return null
  const flowId = resolveFlowId(opts)
  const event: PerfTraceEvent = {
    v: 1,
    ph,
    cat,
    name,
    ts: toTraceTs(atMs),
    tsMs: roundMs(atMs),
    wallTime: wallTimeFor(atMs),
    pid: "renderer",
    tid: "ui",
    ...(opts?.id ? { id: opts.id } : null),
    ...(flowId ? { flowId } : null),
    ...(ph === "i" ? { s: opts?.scope ?? "t" } : null),
    ...(opts?.durMs != null
      ? { dur: toTraceTs(opts.durMs), durMs: roundMs(opts.durMs) }
      : null),
    ...(opts?.args || opts?.subjectKey
      ? { args: { ...(opts?.args ?? {}), subjectKey: opts?.subjectKey } }
      : null),
  }
  pushEvent(event)
  return event
}

function roundMs(value: number): number {
  return Math.round(value * 100) / 100
}

function safeMark(name: string): void {
  try {
    performance.mark(name)
  } catch {
    // Performance marks are diagnostic-only; never let tracing affect UX.
  }
}

function safeMeasure(name: string, start: string, end: string): number | null {
  try {
    performance.measure(name, start, end)
    const entries = performance.getEntriesByName(name, "measure")
    const entry = entries[entries.length - 1]
    return entry?.duration ?? null
  } catch {
    return null
  } finally {
    try {
      performance.clearMarks(start)
      performance.clearMarks(end)
      performance.clearMeasures(name)
    } catch {
      // ignore
    }
  }
}

function armStalledTimer(flow: FlowState): void {
  if (flow.stalledTimer != null) {
    window.clearTimeout(flow.stalledTimer)
  }
  flow.stalledTimer = window.setTimeout(() => {
    if (!enabled || !activeFlows.has(flow.id)) return
    const idleMs = nowMs() - flow.lastProgressAt
    if (idleMs < STALLED_FLOW_MS) {
      armStalledTimer(flow)
      return
    }
    mark("trace.flow_stalled", {
      flowName: flow.name,
      subjectKey: flow.subjectKey,
      idleMs: roundMs(idleMs),
      thresholdMs: STALLED_FLOW_MS,
    }, { flowId: flow.id })
    requestAutoDump("flow-stalled", {
      flowId: flow.id,
      flowName: flow.name,
      subjectKey: flow.subjectKey,
      idleMs: roundMs(idleMs),
    })
  }, STALLED_FLOW_MS)
}

function clearFlowTimer(flow: FlowState): void {
  if (flow.stalledTimer != null) {
    window.clearTimeout(flow.stalledTimer)
    flow.stalledTimer = null
  }
}

function startLongTaskObserver(): void {
  if (longTaskObserver || typeof PerformanceObserver === "undefined") return
  const supported = PerformanceObserver.supportedEntryTypes ?? []
  if (!supported.includes("longtask")) return
  try {
    longTaskObserver = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        const activeFlowIds = [...activeFlows.keys()]
        record("X", "renderer.longtask", "renderer.longtask", entry.startTime, {
          durMs: entry.duration,
          args: {
            activeFlowIds,
            thresholdMs: SLOW_SPAN_MS,
          },
        })
        if (activeFlowIds.length > 0 && entry.duration >= SLOW_SPAN_MS) {
          requestAutoDump("renderer-longtask", {
            durationMs: roundMs(entry.duration),
            activeFlowIds,
          })
        }
      }
    })
    longTaskObserver.observe({ entryTypes: ["longtask"] })
  } catch {
    longTaskObserver = null
  }
}

function stopLongTaskObserver(): void {
  longTaskObserver?.disconnect()
  longTaskObserver = null
}

function setEnabled(next: boolean): void {
  enabled = next
  if (enabled) {
    startLongTaskObserver()
    mark("trace.enabled", { source: "perf-trace" })
  } else {
    stopLongTaskObserver()
  }
}

function startFlow(name: string, args?: JsonObject, opts?: StartOptions): string | null {
  if (!enabled) return null
  if (opts?.subjectKey) {
    const existing = activeFlowForSubject(opts.subjectKey)
    if (existing && existing.name === name) {
      mark("trace.flow_reused", { flowName: name, ...args }, { flowId: existing.id })
      return existing.id
    }
  }
  const id = shortId("flow", nextFlowSeq++)
  const startedAt = nowMs()
  const flow: FlowState = {
    id,
    name,
    subjectKey: opts?.subjectKey,
    args,
    startedAt,
    lastProgressAt: startedAt,
    stalledTimer: null,
  }
  activeFlows.set(id, flow)
  if (opts?.subjectKey) {
    flowsBySubject.set(opts.subjectKey, id)
    completedFlowsBySubject.delete(opts.subjectKey)
  }
  safeMark(nativeName(`${name}.start`, id))
  record("s", name, `${name}.start`, startedAt, {
    id,
    flowId: id,
    args: { ...args, subjectKey: opts?.subjectKey },
  })
  armStalledTimer(flow)
  return id
}

function ensureFlow(name: string, args?: JsonObject, opts?: StartOptions): string | null {
  if (!enabled) return null
  if (opts?.subjectKey) {
    const existing = activeFlowForSubject(opts.subjectKey)
    if (existing && existing.name === name) return existing.id
  }
  return startFlow(name, args, opts)
}

function endFlow(flowId: string | null | undefined, args?: JsonObject): void {
  if (!enabled || !flowId) return
  const flow = activeFlows.get(flowId)
  if (!flow) return
  const endedAt = nowMs()
  const durMs = endedAt - flow.startedAt
  clearFlowTimer(flow)
  activeFlows.delete(flowId)
  if (flow.subjectKey && flowsBySubject.get(flow.subjectKey) === flowId) {
    flowsBySubject.delete(flow.subjectKey)
    completedFlowsBySubject.set(flow.subjectKey, {
      flowId,
      expiresAt: endedAt + COMPLETED_FLOW_CORRELATION_MS,
    })
  }
  const startName = nativeName(`${flow.name}.start`, flow.id)
  const endName = nativeName(`${flow.name}.end`, flow.id)
  const measureName = nativeName(flow.name, flow.id)
  safeMark(endName)
  safeMeasure(measureName, startName, endName)
  record("X", flow.name, flow.name, flow.startedAt, {
    id: flow.id,
    flowId: flow.id,
    durMs,
    args: { ...flow.args, ...args, subjectKey: flow.subjectKey },
  })
  record("f", flow.name, `${flow.name}.end`, endedAt, {
    id: flow.id,
    flowId: flow.id,
    args: { durationMs: roundMs(durMs), ...args },
  })
  if (durMs >= SLOW_FLOW_MS) {
    requestAutoDump("slow-flow", {
      flowId,
      flowName: flow.name,
      subjectKey: flow.subjectKey,
      durationMs: roundMs(durMs),
      thresholdMs: SLOW_FLOW_MS,
    })
  }
}

function endFlowForSubject(subjectKey: string | null | undefined, name?: string, args?: JsonObject): void {
  const flow = activeFlowForSubject(subjectKey)
  if (!flow) return
  if (name && flow.name !== name) return
  endFlow(flow.id, args)
}

function mark(name: string, args?: JsonObject, opts?: RecordOptions): void {
  if (!enabled) return
  const id = shortId("mark", nextSpanSeq++)
  const at = nowMs()
  safeMark(nativeName(name, id))
  record("i", categoryOf(name), name, at, { ...opts, args })
}

function markForSubject(subjectKey: string | null | undefined, name: string, args?: JsonObject): void {
  if (!subjectKey) return
  mark(name, args, { subjectKey })
}

function startSpan(name: string, args?: JsonObject, opts?: RecordOptions): SpanHandle | null {
  if (!enabled) return null
  const id = shortId("span", nextSpanSeq++)
  const start = nowMs()
  const startName = nativeName(`${name}.start`, id)
  const endName = nativeName(`${name}.end`, id)
  const measureName = nativeName(name, id)
  safeMark(startName)
  let ended = false
  return {
    end: (endArgs?: JsonObject) => {
      if (ended) return
      ended = true
      const end = nowMs()
      safeMark(endName)
      const measured = safeMeasure(measureName, startName, endName)
      const durMs = measured ?? end - start
      record("X", categoryOf(name), name, start, {
        ...opts,
        id,
        durMs,
        args: { ...args, ...endArgs },
      })
      if (durMs >= SLOW_SPAN_MS) {
        requestAutoDump("slow-span", {
          spanName: name,
          durationMs: roundMs(durMs),
          thresholdMs: SLOW_SPAN_MS,
          flowId: resolveFlowId(opts),
        })
      }
    },
  }
}

function startSpanForSubject(
  subjectKey: string | null | undefined,
  name: string,
  args?: JsonObject,
): SpanHandle | null {
  if (!subjectKey) return null
  return startSpan(name, args, { subjectKey })
}

function span<T>(name: string, fn: () => T, args?: JsonObject, opts?: RecordOptions): T {
  const handle = startSpan(name, args, opts)
  try {
    return fn()
  } finally {
    handle?.end()
  }
}

function spanForSubject<T>(
  subjectKey: string | null | undefined,
  name: string,
  fn: () => T,
  args?: JsonObject,
): T {
  if (!subjectKey || !enabled) return fn()
  return span(name, fn, args, { subjectKey })
}

async function asyncSpan<T>(
  name: string,
  fn: () => Promise<T>,
  args?: JsonObject,
  opts?: RecordOptions,
): Promise<T> {
  const handle = startSpan(name, args, opts)
  try {
    return await fn()
  } finally {
    handle?.end()
  }
}

async function asyncSpanForSubject<T>(
  subjectKey: string | null | undefined,
  name: string,
  fn: () => Promise<T>,
  args?: JsonObject,
): Promise<T> {
  if (!subjectKey || !enabled) return await fn()
  return await asyncSpan(name, fn, args, { subjectKey })
}

function categoryOf(name: string): string {
  const parts = name.split(".")
  return parts.length > 1 ? parts.slice(0, -1).join(".") : "app"
}

function snapshot(reason: string, trigger: "manual" | "auto"): PerfTraceDumpPayload {
  return {
    reason,
    trigger,
    createdAt: new Date().toISOString(),
    timeOrigin: performance.timeOrigin,
    href: typeof window === "undefined" ? "" : window.location.href,
    events: [...events],
  }
}

async function dump(reason = "manual"): Promise<PerfTraceDumpResult> {
  if (!enabled) return { ok: false, error: "perf trace is disabled" }
  if (!writer) return { ok: false, error: "perf trace dump writer is not registered" }
  mark("trace.dump_requested", { reason, eventCount: events.length })
  const result = await writer(snapshot(reason, "manual"))
  if (result.ok && result.path) {
    lastDumpPath = result.path
    mark("trace.dumped", {
      reason,
      path: result.path,
      eventCount: result.eventCount,
      bytes: result.bytes,
    })
  }
  return result
}

function requestAutoDump(reason: string, args?: JsonObject): void {
  if (!enabled) return
  const now = nowMs()
  if (autoDumpCount >= MAX_AUTO_DUMPS) {
    mark("trace.auto_dump_skipped", {
      reason,
      skipReason: "max-auto-dumps",
      maxAutoDumps: MAX_AUTO_DUMPS,
      ...args,
    })
    return
  }
  if (now - lastAutoDumpAt < AUTO_DUMP_COOLDOWN_MS) {
    mark("trace.auto_dump_skipped", {
      reason,
      skipReason: "cooldown",
      cooldownMs: AUTO_DUMP_COOLDOWN_MS,
      ...args,
    })
    return
  }
  if (!writer) {
    mark("trace.auto_dump_skipped", {
      reason,
      skipReason: "no-writer",
      ...args,
    })
    return
  }
  autoDumpCount++
  lastAutoDumpAt = now
  mark("trace.auto_dump_requested", { reason, ...args })
  window.setTimeout(() => {
    const payload = snapshot(reason, "auto")
    void writer?.(payload)
      .then(result => {
        if (result.ok && result.path) {
          lastDumpPath = result.path
          mark("trace.auto_dumped", {
            reason,
            path: result.path,
            eventCount: result.eventCount,
            bytes: result.bytes,
            ...args,
          })
        } else {
          mark("trace.auto_dump_failed", {
            reason,
            error: result.error ?? "unknown error",
            ...args,
          })
        }
      })
      .catch(err => {
        mark("trace.auto_dump_failed", {
          reason,
          error: err instanceof Error ? err.message : String(err),
          ...args,
        })
      })
  }, 0)
}

function summary(): JsonObject {
  const spanEvents = events.filter(e => e.ph === "X")
  const slowest = spanEvents
    .slice()
    .sort((a, b) => (b.durMs ?? 0) - (a.durMs ?? 0))
    .slice(0, 12)
    .map(e => ({
      name: e.name,
      cat: e.cat,
      durMs: e.durMs,
      flowId: e.flowId,
      args: e.args,
    }))
  return {
    enabled,
    eventCount: events.length,
    droppedEvents,
    activeFlows: [...activeFlows.values()].map(f => ({
      id: f.id,
      name: f.name,
      subjectKey: f.subjectKey,
      ageMs: roundMs(nowMs() - f.startedAt),
      idleMs: roundMs(nowMs() - f.lastProgressAt),
    })),
    autoDumpCount,
    lastDumpPath,
    slowest,
  }
}

function clear(): void {
  events = []
  droppedEvents = 0
  activeFlows.forEach(clearFlowTimer)
  activeFlows.clear()
  flowsBySubject.clear()
  completedFlowsBySubject.clear()
  autoDumpCount = 0
  lastAutoDumpAt = 0
  lastDumpPath = null
  if (enabled) mark("trace.cleared")
}

function setDumpWriter(next: DumpWriter | null): void {
  writer = next
  if (enabled) mark("trace.writer_registered", { registered: next != null })
}

function install(): void {
  if (installed || typeof window === "undefined") return
  installed = true
  enabled = readEnabledFlag()

  window.__zenbuPerf = {
    enable: () => setEnabled(true),
    disable: () => setEnabled(false),
    summary,
    events: () => [...events],
    flows: () => [...activeFlows.values()].map(f => ({ ...f, stalledTimer: null })),
    clear,
    dump,
  }

  if (enabled) {
    startLongTaskObserver()
    mark("trace.installed", { href: window.location.href })
    console.info(
      "[perf-trace] enabled — inspect with window.__zenbuPerf.summary(); dump with window.__zenbuPerf.dump()",
    )
  }
}

declare global {
  interface Window {
    __zenbuPerf?: {
      enable: () => void
      disable: () => void
      summary: () => JsonObject
      events: () => PerfTraceEvent[]
      flows: () => JsonObject[]
      clear: () => void
      dump: (reason?: string) => Promise<PerfTraceDumpResult>
    }
  }
}

export const perfTrace = {
  install,
  enable: () => setEnabled(true),
  disable: () => setEnabled(false),
  isEnabled: () => enabled,
  setDumpWriter,
  summary,
  events: () => [...events],
  clear,
  dump,
  startFlow,
  ensureFlow,
  endFlow,
  endFlowForSubject,
  hasActiveFlowForSubject: (subjectKey: string | null | undefined) =>
    activeFlowForSubject(subjectKey) != null,
  mark,
  markForSubject,
  startSpan,
  startSpanForSubject,
  span,
  spanForSubject,
  asyncSpan,
  asyncSpanForSubject,
}
