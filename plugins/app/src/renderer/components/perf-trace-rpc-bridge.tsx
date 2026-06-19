import { useEffect } from "react"
import { useRpc } from "@zenbujs/core/react"
import {
  perfTrace,
  type PerfTraceDumpPayload,
  type PerfTraceDumpResult,
} from "@/lib/perf-trace"

type PerfTraceRpc = {
  app?: {
    perfTrace?: {
      dump?: (payload: PerfTraceDumpPayload) => Promise<PerfTraceDumpResult>
    }
  }
}

/**
 * Gives the renderer-only perf tracer one explicit persistence seam.
 * The tracer can stay React-free and cheap; this component only adapts
 * its batched dump payload onto the host RPC once a ZenbuProvider exists.
 */
export function PerfTraceRpcBridge() {
  const rpc = useRpc()

  useEffect(() => {
    perfTrace.setDumpWriter(async payload => {
      const dump = (rpc as unknown as PerfTraceRpc).app?.perfTrace?.dump
      if (!dump) {
        return { ok: false, error: "rpc.app.perfTrace.dump is unavailable" }
      }
      return await dump(payload)
    })
    return () => perfTrace.setDumpWriter(null)
  }, [rpc])

  return null
}
