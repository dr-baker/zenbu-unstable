export function authProjectionMatches(args: {
  currentProviderStatuses: Record<string, unknown>
  nextProviderStatuses: Record<string, unknown>
  currentModels: Record<string, unknown>
  nextModels: Record<string, unknown>
}): boolean {
  return (
    stableStringify(args.currentProviderStatuses) ===
      stableStringify(args.nextProviderStatuses) &&
    stableStringify(args.currentModels) === stableStringify(args.nextModels)
  )
}

function stableStringify(value: unknown): string {
  if (value === undefined) return "undefined"
  return JSON.stringify(sortJsonLike(value))
}

function sortJsonLike(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonLike)
  if (!value || typeof value !== "object") return value
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = sortJsonLike((value as Record<string, unknown>)[key])
  }
  return out
}
