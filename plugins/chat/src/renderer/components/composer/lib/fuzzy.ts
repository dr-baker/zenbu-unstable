/**
 * Lightweight fuzzy subsequence scorer optimized for path matching.
 *
 * The scorer walks the query left-to-right, matching characters in the
 * candidate. It rewards:
 *   - consecutive matches (camel-runs)
 *   - matches right after a path boundary (`/`, `_`, `-`, `.`, or case
 *     boundary) — these are word starts
 *   - matches near the end of the candidate (filename > directory)
 *
 * Returns `null` if the query is not a subsequence of the candidate.
 * Higher score = better match. Empty query returns `0` (everything matches).
 *
 * This is intentionally allocation-free in the hot loop — we score
 * thousands of paths per keystroke.
 */
export function fuzzyScore(query: string, candidate: string): number | null {
  if (query.length === 0) return 0
  const q = query.toLowerCase()
  const c = candidate.toLowerCase()
  if (q.length > c.length) return null

  let score = 0
  let qi = 0
  let prevMatched = false
  let lastMatchIdx = -1

  for (let ci = 0; ci < c.length && qi < q.length; ci++) {
    if (c.charCodeAt(ci) !== q.charCodeAt(qi)) {
      prevMatched = false
      continue
    }
    // Base hit
    let hit = 1
    // Consecutive run bonus
    if (prevMatched) hit += 4
    // Word-boundary bonus
    if (ci === 0) {
      hit += 6
    } else {
      const prev = candidate.charCodeAt(ci - 1)
      const isSep = prev === 47 /* / */ || prev === 45 /* - */ ||
        prev === 95 /* _ */ || prev === 46 /* . */ || prev === 32 /* space */
      if (isSep) hit += 5
      else {
        const cur = candidate.charCodeAt(ci)
        // camelCase boundary
        if (cur >= 65 && cur <= 90 && (prev < 65 || prev > 90)) hit += 3
      }
    }
    // Filename bias — last `/` onward gets a small boost
    score += hit
    lastMatchIdx = ci
    prevMatched = true
    qi++
  }

  if (qi < q.length) return null

  // Filename bias: matches inside the basename are preferred over dir-only matches.
  const lastSlash = candidate.lastIndexOf("/")
  if (lastMatchIdx >= lastSlash) score += 8

  // Slight penalty for very long candidates so two paths with the same
  // matching characters prefer the shorter one.
  score -= Math.floor(candidate.length / 32)

  return score
}

export type ScoredEntry<T> = { entry: T; score: number }

/**
 * Score every entry against `query`, drop non-matches, sort descending by
 * score (stable by original index on ties), and truncate to `limit`.
 *
 * `getText` returns the string to score against. When `query` is empty,
 * the first `limit` entries are returned with score `0`.
 */
export function rankEntries<T>(
  entries: readonly T[],
  query: string,
  getText: (entry: T) => string,
  limit: number,
): ScoredEntry<T>[] {
  if (query.length === 0) {
    const out: ScoredEntry<T>[] = []
    const cap = Math.min(limit, entries.length)
    for (let i = 0; i < cap; i++) out.push({ entry: entries[i]!, score: 0 })
    return out
  }
  const scored: { entry: T; score: number; idx: number }[] = []
  for (let i = 0; i < entries.length; i++) {
    const s = fuzzyScore(query, getText(entries[i]!))
    if (s === null) continue
    scored.push({ entry: entries[i]!, score: s, idx: i })
  }
  scored.sort((a, b) => (b.score - a.score) || (a.idx - b.idx))
  if (scored.length > limit) scored.length = limit
  return scored.map(({ entry, score }) => ({ entry, score }))
}
