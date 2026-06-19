import { loadProjectContextFiles } from "@earendil-works/pi-coding-agent"

export type AgentsFile = { path: string; content: string }

/**
 * Walk each extra directory through pi's own `loadProjectContextFiles`
 * (the same loader that produces the primary cwd's AGENTS.md list)
 * and concatenate the results. Dedupes by absolute path so a dir that
 * happens to already be in the primary scan (e.g. the cwd itself
 * showing up in `extraDirectories` by mistake) doesn't double-add.
 *
 * Errors from any single dir are swallowed and logged — a malformed
 * or unreadable extra dir shouldn't kill the whole session.
 */
export function collectExtraAgentsFiles(
  extraDirs: readonly string[],
  agentDir: string,
  existing: readonly AgentsFile[] = [],
): AgentsFile[] {
  const seen = new Set(existing.map(f => f.path))
  const out: AgentsFile[] = []
  for (const dir of extraDirs) {
    if (!dir) continue
    try {
      const found = loadProjectContextFiles({ cwd: dir, agentDir })
      for (const f of found) {
        if (seen.has(f.path)) continue
        seen.add(f.path)
        out.push(f)
      }
    } catch (err) {
      console.warn(
        "[extra-dirs] failed to load AGENTS.md from",
        dir,
        err,
      )
    }
  }
  return out
}

/**
 * Render a "## Additional working directories" section for the
 * system prompt. Returned as a single string the caller appends
 * into `appendSystemPrompt` (each entry there shows up as its own
 * section after pi's default prompt). Returns null when there's
 * nothing to add so the caller can no-op cleanly.
 */
export function formatExtraDirsPrompt(
  extraDirs: readonly string[],
): string | null {
  const dirs = extraDirs.map(d => d.trim()).filter(d => d.length > 0)
  if (dirs.length === 0) return null
  const lines: string[] = []
  lines.push("## Additional working directories")
  lines.push("")
  lines.push(
    "Alongside your primary working directory, this session has access to",
  )
  lines.push(
    "the following directories. You may read, edit, and run commands in",
  )
  lines.push("them as needed:")
  lines.push("")
  for (const dir of dirs) {
    lines.push(`- \`${dir}\``)
  }
  lines.push("")
  lines.push(
    "Each directory's own AGENTS.md (if present) has been loaded into your",
  )
  lines.push("context above.")
  return lines.join("\n")
}
