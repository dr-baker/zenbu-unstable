/**
 * Auto-discover an available small model for ad-hoc completion calls.
 *
 * Mirrors what `pi-coding-agent` does internally:
 *   - AuthStorage discovers credentials from env vars and ~/.pi/agent/auth.json
 *   - ModelRegistry loads built-in + custom models, filters to ones with valid auth
 *   - getApiKeyAndHeaders resolves the actual key (handles OAuth refresh uniformly
 *     with plain API keys)
 *
 * We prefer a small/cheap model (haiku/mini/flash/nano/small) at the latest
 * version number, falling back to the cheapest available if nothing matches.
 */
import { type Api, type Model } from "@earendil-works/pi-ai"
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent"

const SMALL_MODEL_KEYWORDS = /haiku|mini|flash|nano|small/i
const DATED_ID = /-\d{8}$/

/** Parse "claude-haiku-4-5" → [4, 5]; "claude-3-5-haiku-latest" → [3, 5]. */
function versionTuple(id: string): number[] {
  return Array.from(id.matchAll(/\d+/g)).map(m => Number(m[0]))
}

/** Lexicographic compare; missing positions count as -1 so longer doesn't auto-win. */
function compareTuples(a: number[], b: number[]): number {
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i++) {
    const av = a[i] ?? -1
    const bv = b[i] ?? -1
    if (av !== bv) return av - bv
  }
  return 0
}

/**
 * Pick a small model from the available pool.
 *  1. Filter to "small" by id keyword.
 *  2. Prefer aliases (no YYYYMMDD date suffix) over dated snapshots.
 *  3. Pick highest version number.
 * Falls back to the full pool if no small model matches.
 */
export function pickSmallModel(available: Model<Api>[]): Model<Api> {
  if (available.length === 0) {
    throw new Error("no available models")
  }
  const small = available.filter(m => SMALL_MODEL_KEYWORDS.test(m.id))
  const pool = small.length > 0 ? small : available
  const aliases = pool.filter(m => !DATED_ID.test(m.id))
  const candidates = aliases.length > 0 ? aliases : pool
  return [...candidates].sort((a, b) =>
    compareTuples(versionTuple(b.id), versionTuple(a.id)),
  )[0]
}

export interface ResolvedModel {
  model: Model<Api>
  apiKey?: string
  headers?: Record<string, string>
}

/**
 * Singleton-ish: we re-use the same AuthStorage + ModelRegistry to avoid
 * re-reading auth.json on every call. `refresh()` re-pulls credentials so
 * newly-added keys land without a process restart.
 */
let cachedAuth: AuthStorage | null = null
let cachedRegistry: ModelRegistry | null = null

function getRegistry(): ModelRegistry {
  if (!cachedRegistry) {
    cachedAuth = AuthStorage.create()
    cachedRegistry = ModelRegistry.create(cachedAuth)
  }
  cachedRegistry.refresh()
  return cachedRegistry
}

export async function resolveSmallModel(): Promise<ResolvedModel> {
  const registry = getRegistry()
  const available = registry.getAvailable()
  if (available.length === 0) {
    throw new Error(
      "no available models — set ANTHROPIC_API_KEY (or another provider key) or run `pi /login`",
    )
  }
  const model = pickSmallModel(available)
  const resolved = await registry.getApiKeyAndHeaders(model)
  if (!resolved.ok) {
    throw new Error(`failed to resolve auth for ${model.provider}/${model.id}: ${resolved.error}`)
  }
  return { model, apiKey: resolved.apiKey, headers: resolved.headers }
}
