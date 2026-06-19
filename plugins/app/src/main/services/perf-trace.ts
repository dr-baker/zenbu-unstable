import * as fsp from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { Service } from "@zenbujs/core/runtime"

export type PerfTraceDumpPayload = {
  reason: string
  trigger: "manual" | "auto"
  createdAt: string
  timeOrigin: number
  href: string
  events: unknown[]
}

export type PerfTraceDumpResult = {
  ok: boolean
  path?: string
  eventCount?: number
  bytes?: number
  error?: string
}

const MAX_EVENTS_PER_DUMP = 10_000
const LOG_DIR = path.join(os.homedir(), ".zenbu", "logs", "perf-traces")

export class PerfTraceService extends Service.create({ key: "perfTrace" }) {
  async dump(payload: PerfTraceDumpPayload): Promise<PerfTraceDumpResult> {
    try {
      const events = Array.isArray(payload.events)
        ? payload.events.slice(-MAX_EVENTS_PER_DUMP)
        : []
      await fsp.mkdir(LOG_DIR, { recursive: true })
      const filePath = path.join(
        LOG_DIR,
        `zenbu-perf-${stamp(new Date())}-${slug(payload.trigger)}-${slug(payload.reason)}.jsonl`,
      )
      const truncated = Array.isArray(payload.events)
        ? payload.events.length > events.length
        : false
      const dumpedAt = Date.now()
      const dumpedAtMs = Math.max(0, dumpedAt - payload.timeOrigin)
      const dumpEvent = {
        v: 1,
        ph: "i",
        cat: "trace",
        name: payload.trigger === "auto" ? "trace.auto_dumped" : "trace.dumped",
        ts: Math.round(dumpedAtMs * 1000),
        tsMs: Math.round(dumpedAtMs * 100) / 100,
        wallTime: new Date(dumpedAt).toISOString(),
        pid: "main",
        tid: "perf-trace",
        s: "t",
        args: {
          reason: payload.reason,
          trigger: payload.trigger,
          path: filePath,
          sourceEventCount: events.length,
          truncated,
        },
      }
      const writtenEvents = [...events, dumpEvent]
      const header = {
        type: "zenbu.perf.dump",
        version: 1,
        trigger: payload.trigger,
        reason: payload.reason,
        createdAt: payload.createdAt,
        timeOrigin: payload.timeOrigin,
        href: payload.href,
        path: filePath,
        eventCount: writtenEvents.length,
        sourceEventCount: events.length,
        truncated,
      }
      const body = [header, ...writtenEvents]
        .map(line => JSON.stringify(line))
        .join("\n") + "\n"
      await fsp.writeFile(filePath, body, "utf8")
      return {
        ok: true,
        path: filePath,
        eventCount: writtenEvents.length,
        bytes: Buffer.byteLength(body, "utf8"),
      }
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }
}

function stamp(date: Date): string {
  const pad = (n: number) => n.toString().padStart(2, "0")
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join("")
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "trace"
}
