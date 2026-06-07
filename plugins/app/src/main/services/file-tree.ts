import path from "node:path"
import fs from "node:fs/promises"
import { nanoid } from "nanoid"
import { watch, type FSWatcher } from "node:fs"
import { Service } from "@zenbujs/core/runtime"
import {
  DbService,
  RpcService,
} from "@zenbujs/core/services"
import { IGNORE_DIRS } from "../lib/ignore-dirs"
import type { Schema } from "../schema"

type FileTreeIndex = Schema["fileTreeIndexes"][string]

const MAX_PATHS = 20_000
const MAX_FILE_BYTES = 2 * 1024 * 1024
/** How many paths to accumulate between intermediate DB publishes during a
 * full walk. Tuned so that the menu paints within ~50ms on a cold start
 * for typical repos. */
const WALK_PUBLISH_CHUNK = 500
/** Debounce for FS-watcher-triggered re-indexes. Bursty saves (e.g. `pnpm
 * install`) collapse into a single walk. */
const WATCH_DEBOUNCE_MS = 250

/**
 * Registers three views and maintains a per-scope file index in
 * `root.app.fileTreeIndexes`:
 *
 *  - `"file-tree"`         — pane view: tree + preview in a split. Plain
 *                              `kind: "view"`, no sidebar flag.
 *  - `"file-tree-sidebar"` — sidebar view: just the tree. Clicking a
 *                              file calls `openFile({...})` which emits
 *                              an `openFileInActivePane` event the main
 *                              shell catches to add a new pane tab.
 *  - `"file"`              — pane view tagged `kind: "embed"`: read-only
 *                              file viewer that takes `{ directory, path }`
 *                              as args. The `embed` kind keeps it out of
 *                              the command palette (it needs args to be
 *                              meaningful) while still letting other
 *                              services open it via `useOpenView`.
 *
 * All three are vite-aliased over the renderer's server so they share
 * tailwind / theme vars. The views read file-tree state straight from
 * the DB so first render is synchronous.
 */
export class FileTreeService extends Service.create({
  key: "fileTree",
  deps: {
    db: DbService,
    // Needed so we can emit `openFileInActivePane` when the sidebar
    // view asks to open a file.
    rpc: RpcService,
  },
}) {
  /** Scope ids we have an in-flight indexing job for. Prevents re-entrancy
   * if `scopes` fires twice in quick succession. */
  private indexing = new Set<string>()
  /** Active FS watchers keyed by scopeId. */
  private watchers = new Map<string, { watcher: FSWatcher; directory: string }>()
  /** Debounce timers for watcher-triggered re-indexes. */
  private watchTimers = new Map<string, NodeJS.Timeout>()

  evaluate() {
    this.setup("inject-file-tree-view", () =>
      this.inject({
        name: "file-tree",
        modulePath: "./src/renderer/views/file-tree/file-tree-app.tsx",
        exportName: "FileTreeApp",
        meta: { kind: "view", label: "Files" },
      }),
    )

    // The right-sidebar `file-tree-sidebar` view lives in the
    // standalone `@zenbu/file-tree-sidebar` plugin. The indexing
    // pipeline + `openFile` RPC below stay here and are consumed
    // by that plugin via `rpc.app.fileTree.*`.

    this.setup("inject-file-view", () =>
      this.inject({
        name: "file",
        modulePath: "./src/renderer/views/file/file-view.tsx",
        // `kind: "embed"` excludes the view from the command
        // palette (it needs args to be useful) while still letting
        // other services / event handlers open it via `useOpenView`.
        meta: { kind: "embed", label: "File" },
      }),
    )

    this.setup("index-scopes", () => {
      void this.reconcileIndexes()
      const unsub = this.ctx.db.client.app.scopes.subscribe(() => {
        void this.reconcileIndexes()
      })
      return () => {
        unsub()
        for (const t of this.watchTimers.values()) clearTimeout(t)
        this.watchTimers.clear()
        for (const { watcher } of this.watchers.values()) watcher.close()
        this.watchers.clear()
      }
    })
  }

  /** Called by the file-tree sidebar view when the user clicks a file.
   * Re-broadcasts as an `openFileInActivePane` event so the main shell
   * (which owns the pane layout) can add a tab in the active pane. We
   * intentionally don't reach into pane state from here — the service
   * doesn't know which window is active. */
  async openFile(args: {
    directory: string
    path: string
  }): Promise<{ ok: true }> {
    this.ctx.rpc.emit.app.openFileInActivePane({
      directory: args.directory,
      path: args.path,
    })
    return { ok: true }
  }

  /** Re-index a scope on demand. Useful when the renderer wants a fresh
   * view of disk after a known mutation outside of FS watcher coverage. */
  async reindex(args: { scopeId: string }): Promise<{ ok: true }> {
    const scope = this.ctx.db.client.readRoot().app.scopes[args.scopeId]
    if (!scope) throw new Error(`unknown scope: ${args.scopeId}`)
    await this.indexScope(scope.id, scope.directory)
    return { ok: true }
  }

  async readFile(args: {
    directory: string
    path: string
  }): Promise<{ content: string; truncated: boolean; binary: boolean }> {
    const abs = safeJoin(args.directory, args.path)
    const stat = await fs.stat(abs)
    if (!stat.isFile()) throw new Error(`not a file: ${args.path}`)
    const buf = await fs.readFile(abs)
    if (looksBinary(buf)) {
      return { content: "", truncated: false, binary: true }
    }
    if (buf.byteLength > MAX_FILE_BYTES) {
      return {
        content: buf.subarray(0, MAX_FILE_BYTES).toString("utf8"),
        truncated: true,
        binary: false,
      }
    }
    return { content: buf.toString("utf8"), truncated: false, binary: false }
  }

  async writeFile(args: {
    directory: string
    path: string
    content: string
  }): Promise<{ ok: true }> {
    const abs = safeJoin(args.directory, args.path)
    await fs.writeFile(abs, args.content, "utf8")
    return { ok: true }
  }

  /** Drop indexes whose `paths` are still inline arrays from before the
   * collection migration. Readers only understand collection refs. */
  private async purgeLegacyIndexes(): Promise<void> {
    const indexes = this.ctx.db.client.readRoot().app.fileTreeIndexes
    const legacyIds = Object.entries(indexes)
      .filter(([, index]) => index && Array.isArray(index.paths))
      .map(([scopeId]) => scopeId)
    if (legacyIds.length === 0) return
    await this.ctx.db.client.update(root => {
      for (const scopeId of legacyIds) {
        delete root.app.fileTreeIndexes[scopeId]
      }
    })
  }

  /** For each scope: ensure an index exists, and a watcher is running on
   * its directory. For each index/watcher whose scope is gone or whose
   * directory has changed: drop / re-index / re-watch. */
  private async reconcileIndexes(): Promise<void> {
    await this.purgeLegacyIndexes()

    const root = this.ctx.db.client.readRoot()
    const scopes = root.app.scopes
    const indexes = root.app.fileTreeIndexes

    for (const scope of Object.values(scopes)) {
      const existing = indexes[scope.id]
      const existingWatcher = this.watchers.get(scope.id)
      const dirChanged = existingWatcher?.directory !== scope.directory
      if (dirChanged) {
        existingWatcher?.watcher.close()
        this.watchers.delete(scope.id)
        this.startWatcher(scope.id, scope.directory)
      }
      if (existing && existing.directory === scope.directory) continue
      void this.indexScope(scope.id, scope.directory)
    }

    const liveIds = new Set(Object.keys(scopes))
    const orphaned = Object.keys(indexes).filter(id => !liveIds.has(id))
    if (orphaned.length > 0) {
      void this.ctx.db.client.update(r => {
        for (const id of orphaned) delete r.app.fileTreeIndexes[id]
      })
    }
    for (const id of Array.from(this.watchers.keys())) {
      if (liveIds.has(id)) continue
      this.watchers.get(id)?.watcher.close()
      this.watchers.delete(id)
      const t = this.watchTimers.get(id)
      if (t) clearTimeout(t)
      this.watchTimers.delete(id)
    }
  }

  /** Start a recursive FS watcher on `directory`. Bursty events collapse
   * into a single debounced re-index. We use Node's built-in `fs.watch`
   * with `recursive: true` — supported on macOS and Windows natively,
   * and on Linux from Node 20 onward (which Electron 28+ bundles). */
  private startWatcher(scopeId: string, directory: string): void {
    let watcher: FSWatcher
    try {
      watcher = watch(
        directory,
        { recursive: true, persistent: false },
        (_event, filename) => {
          // Skip events inside ignored dirs cheaply — the walker will
          // filter them too, but this saves us scheduling work.
          // `fs.watch({ recursive: true })` reports paths relative to
          // the watched root. When the watched root is a parent folder
          // containing repos/worktrees, generated writes show up as e.g.
          // `repo/.zenbu/db/...`, so checking only the first segment lets
          // Zenbu's own DB writes trigger an endless reindex loop.
          if (
            typeof filename === "string" &&
            shouldIgnoreWatchedPath(filename)
          ) {
            return
          }
          this.scheduleReindex(scopeId, directory)
        },
      )
    } catch (err) {
      // ENOENT (folder doesn't exist yet) is expected; don't warn.
      const code = (err as NodeJS.ErrnoException)?.code
      if (code !== "ENOENT") {
        console.warn(
          `[fileTree] failed to start watcher for ${directory}:`,
          err instanceof Error ? err.message : err,
        )
      }
      return
    }
    watcher.on("error", err => {
      console.warn(`[fileTree] watcher error for ${directory}:`, err.message)
    })
    this.watchers.set(scopeId, { watcher, directory })
  }

  private scheduleReindex(scopeId: string, directory: string): void {
    const existing = this.watchTimers.get(scopeId)
    if (existing) clearTimeout(existing)
    const t = setTimeout(() => {
      this.watchTimers.delete(scopeId)
      // Re-check the scope still points at this directory before walking.
      const scope = this.ctx.db.client.readRoot().app.scopes[scopeId]
      if (!scope || scope.directory !== directory) return
      if (process.env.ZENBU_FILE_TREE_TRACE === "1") {
        console.info(`[fileTree-trace] watcher re-index scope=${scopeId}`)
      }
      void this.indexScope(scopeId, directory)
    }, WATCH_DEBOUNCE_MS)
    this.watchTimers.set(scopeId, t)
  }

  private async indexScope(scopeId: string, directory: string): Promise<void> {
    if (this.indexing.has(scopeId)) return
    this.indexing.add(scopeId)
    const trace = process.env.ZENBU_FILE_TREE_TRACE === "1"
    let concatBatches = 0
    let concatItems = 0
    const previousPathsRef = this.ctx.db.client.readRoot().app.fileTreeIndexes[
      scopeId
    ]?.paths ?? null
    const pathsRef = {
      collectionId: nanoid(),
      debugName: `file-tree-paths-${scopeId}`,
    } as FileTreeIndex["paths"]
    if (trace) {
      console.info(
        `[fileTree-trace] indexScope start scope=${scopeId} dir=${directory} collection=${pathsRef.collectionId}`,
      )
    }
    try {
      await this.ctx.db.client.update(root => {
        const prev = root.app.fileTreeIndexes[scopeId]
        root.app.fileTreeIndexes[scopeId] = {
          scopeId,
          directory,
          // Rotate the collection ref on every walk so incremental
          // `.concat()` lands in a fresh collection instead of
          // rewriting a 20k-path array into root.json.
          paths: pathsRef,
          status: "indexing",
          error: null,
          indexedAt: prev?.indexedAt ?? 0,
          truncated: false,
        }
      })

      const paths: string[] = []
      let lastPublished = 0
      const publishProgress = async () => {
        if (paths.length - lastPublished < WALK_PUBLISH_CHUNK) return
        const batch = paths
          .slice(lastPublished)
          .map(path => ({ path }))
        lastPublished = paths.length
        await this.ctx.db.client.app.fileTreeIndexes[scopeId].paths.concat(
          batch,
        )
        if (trace) {
          concatBatches++
          concatItems += batch.length
        }
      }
      await walk(directory, "", paths, publishProgress)
      paths.sort()
      const truncated = paths.length >= MAX_PATHS
      if (paths.length > lastPublished) {
        const tail = paths.slice(lastPublished).map(path => ({ path }))
        await this.ctx.db.client.app.fileTreeIndexes[scopeId].paths.concat(
          tail,
        )
        if (trace) {
          concatBatches++
          concatItems += tail.length
        }
      }

      await this.ctx.db.client.update(root => {
        const cur = root.app.fileTreeIndexes[scopeId]
        if (!cur || cur.directory !== directory) return
        if (cur.paths.collectionId !== pathsRef.collectionId) return
        cur.status = "idle"
        cur.error = null
        cur.indexedAt = Date.now()
        cur.truncated = truncated
      })
      if (
        previousPathsRef &&
        previousPathsRef.collectionId !== pathsRef.collectionId
      ) {
        await removeCollectionDir(
          this.ctx.db.dbPath,
          previousPathsRef.collectionId,
        )
      }
      if (trace) {
        console.info(
          `[fileTree-trace] indexScope done scope=${scopeId} paths=${paths.length} concats=${concatBatches} concatItems=${concatItems}`,
        )
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await this.ctx.db.client.update(root => {
        const cur = root.app.fileTreeIndexes[scopeId]
        root.app.fileTreeIndexes[scopeId] = {
          scopeId,
          directory,
          paths: previousPathsRef ?? cur?.paths ?? pathsRef,
          status: "error",
          error: message,
          indexedAt: cur?.indexedAt ?? 0,
          truncated: cur?.truncated ?? false,
        }
      })
      if (
        previousPathsRef &&
        previousPathsRef.collectionId !== pathsRef.collectionId
      ) {
        await removeCollectionDir(this.ctx.db.dbPath, pathsRef.collectionId)
      }
    } finally {
      this.indexing.delete(scopeId)
    }
  }
}

function shouldIgnoreWatchedPath(filename: string): boolean {
  return filename.split(/[\\/]+/).some(segment => IGNORE_DIRS.has(segment))
}

async function removeCollectionDir(
  dbPath: string,
  collectionId: string,
): Promise<void> {
  if (!collectionId) return
  await fs.rm(path.join(dbPath, "collections", collectionId), {
    recursive: true,
    force: true,
  })
}

async function walk(
  root: string,
  rel: string,
  out: string[],
  onProgress?: () => Promise<void>,
): Promise<void> {
  if (out.length >= MAX_PATHS) return
  let entries: import("node:fs").Dirent[]
  try {
    entries = await fs.readdir(path.join(root, rel), { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (out.length >= MAX_PATHS) return
    if (IGNORE_DIRS.has(entry.name)) continue
    const childRel = rel ? `${rel}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      await walk(root, childRel, out, onProgress)
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      out.push(childRel)
      if (onProgress) await onProgress()
    }
  }
}

/** Resolve `rel` against `root`. We intentionally do NOT refuse paths
 * that escape `root` via `..` or absolute segments: tool calls (and
 * sometimes the user) legitimately point at files outside of the
 * indexed scope (`~/.zenbu/plugins/...`, sibling repos, etc.) and the
 * UI should happily open them rather than throwing a `path escapes
 * root` error mid-click. `path.resolve` already normalizes `..` and
 * treats an absolute `rel` as an override, which is exactly what we
 * want here. */
function safeJoin(root: string, rel: string): string {
  const normalizedRoot = path.resolve(root)
  return path.resolve(normalizedRoot, rel)
}

/** Cheap NUL-byte heuristic. Good enough to keep CodeMirror from being
 * handed obviously-binary blobs. */
function looksBinary(buf: Buffer): boolean {
  const limit = Math.min(buf.byteLength, 8192)
  for (let i = 0; i < limit; i++) {
    if (buf[i] === 0) return true
  }
  return false
}
