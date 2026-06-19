import type { FileEntry, FileEntryProvider } from "../types"
import { fuzzyScore } from "./fuzzy"

type PathRow = string | { path: string }

export function createFileEntryProvider(
  rows: readonly PathRow[],
  version: string,
): FileEntryProvider {
  let pathSet: ReadonlySet<string> | null = null
  return {
    version,
    search(query, limit) {
      return searchPathRows(rows, query, limit)
    },
    getPathSet() {
      if (!pathSet) {
        const next = new Set<string>()
        for (const row of rows) next.add(pathOf(row))
        pathSet = next
      }
      return pathSet
    },
  }
}

export function searchPathRows(
  rows: readonly PathRow[],
  query: string,
  limit: number,
): FileEntry[] {
  if (limit <= 0) return []
  if (query.length === 0) {
    const out: FileEntry[] = []
    const cap = Math.min(limit, rows.length)
    for (let i = 0; i < cap; i++) out.push(fileEntryFromPath(pathOf(rows[i]!)))
    return out
  }

  const scored: { path: string; score: number; idx: number }[] = []
  for (let i = 0; i < rows.length; i++) {
    const path = pathOf(rows[i]!)
    const score = fuzzyScore(query, path)
    if (score !== null) scored.push({ path, score, idx: i })
  }
  scored.sort((a, b) => b.score - a.score || a.idx - b.idx)
  if (scored.length > limit) scored.length = limit
  return scored.map(item => fileEntryFromPath(item.path))
}

function pathOf(row: PathRow): string {
  return typeof row === "string" ? row : row.path
}

function fileEntryFromPath(path: string): FileEntry {
  const slash = path.lastIndexOf("/")
  return { path, name: slash >= 0 ? path.slice(slash + 1) : path }
}
