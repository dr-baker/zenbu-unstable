import fs from "node:fs"
import fsp from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { nativeImage } from "electron"
import { nanoid } from "nanoid"
import { Service } from "@zenbujs/core/runtime"
import { DbService } from "@zenbujs/core/services"
import { ReposService } from "./repos"
import type { Schema } from "../schema"

type WindowState = Schema["windowStates"][string]
type ScopePaneState = WindowState["scopePanes"][string]

const PLAYGROUND_DIR_NAME = "zenbu-playground"
const PLAYGROUND_WORKSPACE_NAME = "Playground"
/** Matches `DEFAULT_WINDOW_ID` in window-state/window-id.ts. */
const MAIN_WINDOW_ID = "main"
/** Filename the app icon is copied to inside the playground folder.
 * Generic stem so `WorkspaceIconService` would re-discover it too
 * (see its `STEM_SCORES`). */
const PLAYGROUND_ICON_NAME = "icon.png"

/** App icon location relative to the Zenbu source root. Ships in
 * production builds via the per-plugin `assets` include glob. */
const APP_ICON_RELATIVE = path.join("plugins", "app", "assets", "icon.png")

/**
 * Walk up from `start` looking for the directory that actually
 * contains the app icon at `plugins/app/assets/icon.png`.
 *
 * This is self-validating: instead of trusting a marker file that
 * may or may not ship (the root `AGENTS.md` is *not* in production
 * builds, which is why the playground icon silently failed there),
 * we look for the icon itself. Returns the absolute icon path, or
 * `null` if nothing matched on the way up.
 */
function walkUpForIcon(start: string): string | null {
  let current = path.resolve(start)
  for (;;) {
    const candidate = path.join(current, APP_ICON_RELATIVE)
    if (fs.existsSync(candidate)) return candidate
    const parent = path.dirname(current)
    if (parent === current) return null
    current = parent
  }
}

/**
 * Resolve the absolute path of the app icon shipped with this
 * build. This is "the weird app where the source is on disk", so
 * the icon is reachable from the running main-process module:
 *
 *   1. `ZENBU_SOURCE_DIR` env override.
 *   2. Walk up from this compiled module's directory looking for
 *      the icon itself at the known sub-path. Self-validating, so
 *      it doesn't depend on a marker file that may not ship in
 *      production (the root `AGENTS.md` is excluded from builds).
 *
 * Returns `null` if nothing resolves (we then just leave the
 * playground on its letter tile).
 */
function resolveAppIconPath(): string | null {
  const fromEnv = process.env.ZENBU_SOURCE_DIR?.trim()
  if (fromEnv) {
    const candidate = path.join(path.resolve(fromEnv), APP_ICON_RELATIVE)
    if (fs.existsSync(candidate)) return candidate
  }
  try {
    const here = path.dirname(fileURLToPath(import.meta.url))
    const icon = walkUpForIcon(here)
    if (icon) return icon
  } catch {
    // import.meta.url not a file URL (unusual bundling) — give up.
  }
  return null
}

/** Alpha below this counts as "empty" when finding content bounds. */
const ICON_ALPHA_THRESHOLD = 8
/** Skip trimming if the content already fills this fraction of the
 * canvas in both axes — nothing meaningful to crop. */
const ICON_FILL_SKIP_RATIO = 0.98

/**
 * Trim the fully-transparent margin off a PNG so the mark fills the
 * frame instead of floating inside the app icon's safe-area padding
 * (which is why it rendered tiny in the rail).
 *
 * Purely in-memory: takes the source bytes, returns new PNG bytes.
 * It never reads or writes the source file, so the true app icon on
 * disk is never mutated. Returns the input bytes unchanged on any
 * failure or when there's nothing worth cropping.
 */
function trimTransparentMargin(srcBytes: Buffer): Buffer {
  try {
    const img = nativeImage.createFromBuffer(srcBytes)
    const { width, height } = img.getSize()
    if (!width || !height) return srcBytes
    // BGRA, row-major; 4 bytes per pixel.
    const bmp = img.toBitmap()
    if (bmp.length < width * height * 4) return srcBytes

    let minX = width
    let minY = height
    let maxX = -1
    let maxY = -1
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const alpha = bmp[(y * width + x) * 4 + 3]
        if (alpha > ICON_ALPHA_THRESHOLD) {
          if (x < minX) minX = x
          if (x > maxX) maxX = x
          if (y < minY) minY = y
          if (y > maxY) maxY = y
        }
      }
    }
    // Fully transparent — nothing to do.
    if (maxX < minX || maxY < minY) return srcBytes

    const cropW = maxX - minX + 1
    const cropH = maxY - minY + 1
    if (
      cropW >= width * ICON_FILL_SKIP_RATIO &&
      cropH >= height * ICON_FILL_SKIP_RATIO
    ) {
      return srcBytes
    }

    const cropped = img.crop({
      x: minX,
      y: minY,
      width: cropW,
      height: cropH,
    })
    const out = cropped.toPNG()
    return out.length > 0 ? Buffer.from(out) : srcBytes
  } catch {
    return srcBytes
  }
}

/**
 * Seeds the auto-created "Playground" workspace on a fresh DB:
 * materializes `~/zenbu-playground` (sample files + optional git
 * repo) and opens it with the `tutorial` view as the default tab.
 * Runs before `InitService` (via its deps) so the window lands on
 * the playground instead of the onboarding screen. Idempotent —
 * a no-op once a `playground: true` workspace exists.
 */
export class PlaygroundService extends Service.create({
  key: "playground",
  deps: { db: DbService, repos: ReposService },
}) {
  async evaluate() {
    const root = this.ctx.db.client.readRoot()
    const existing = Object.values(root.app.workspaces).find(
      w => w.playground === true && !w.archived,
    )
    if (existing) {
      // Re-create the folder if the user deleted it on disk, then
      // make sure the first window still lands on the playground.
      await this.ensureExistingPlaygroundOnDisk(existing.id)
      // Backfill the app icon onto playgrounds created before this
      // shipped (they're sitting on the "P" letter tile).
      const scope = Object.values(
        this.ctx.db.client.readRoot().app.scopes,
      ).find(s => s.workspaceId === existing.id && !s.archived)
      if (scope) await this.ensurePlaygroundIcon(existing.id, scope.directory)
      await this.pointMainWindowAtPlayground(existing.id)
      return
    }

    const ensured = await this.ensurePlaygroundDirectory()
    if (!ensured) return
    const { directory, created } = ensured

    // Sample files only on fresh creation (never clobber the user's).
    if (created) {
      await this.seedSampleFiles(directory)
    }

    const workspaceId = nanoid()
    const scopeId = nanoid()
    const paneId = nanoid()
    const tabId = nanoid()
    const now = Date.now()

    await this.ctx.db.client.update(root => {
      root.app.workspaces[workspaceId] = {
        id: workspaceId,
        name: PLAYGROUND_WORKSPACE_NAME,
        createdAt: now,
        icon: null,
        iconAuto: null,
        iconAutoAttempted: true, // Skip the discovery walk for an empty folder.
        archived: false,
        kind: "default",
        defaultWorktreeBranch: null,
        playground: true,
      }
      root.app.scopes[scopeId] = {
        id: scopeId,
        workspaceId,
        directory,
        repoId: null,
        extraDirectories: [],
        createdAt: now,
        archived: false,
        archivedAt: null,
        pinnedAt: now,
        unpinnedAt: null,
        pluginName: null,
      }

      const ws = ensureWindowState(root, MAIN_WINDOW_ID)
      // Only redirect from the onboarding view, never override an
      // existing workspace/view choice.
      if (ws.activeView.kind === "onboarding") {
        ws.activeView = { kind: "workspace", workspaceId }
        ws.selectedScopeId = scopeId
        ws.workspaceActiveScope[workspaceId] = scopeId
      }
      // Left sidebar collapsed for the playground (per-workspace
      // state, so it doesn't affect projects the user opens later).
      ws.workspaceUiStates[workspaceId] = {
        sidebarWidth: null,
        leftSidebarOpen: false,
        leftSidebarTab: "agent",
      }
      // Default tab is the registered `tutorial` view, not a chat.
      const initialContent = {
        kind: "view" as const,
        viewType: "tutorial",
        args: {},
      }
      const paneState: ScopePaneState = {
        panes: [
          {
            id: paneId,
            tabs: [
              {
                id: tabId,
                content: initialContent,
              },
            ],
            activeTabId: tabId,
          },
        ],
        activePaneId: paneId,
      }
      ws.scopePanes[scopeId] = paneState
    })

    // Copy the app icon into the folder and set it as the
    // workspace icon so the rail shows the Zenbu mark instead of
    // the "P" letter tile.
    await this.ensurePlaygroundIcon(workspaceId, directory)

    await this.gitInitIfAvailable(directory)
  }

  /**
   * Give the playground the app icon, two ways at once (per the
   * design notes): copy the icon file into the project folder
   * *and* set it as the workspace's auto icon so the rail updates
   * immediately without waiting on a discovery walk.
   *
   * Idempotent and best-effort: never clobbers an existing
   * in-folder icon or an icon the user already chose, and silently
   * gives up if the source icon can't be resolved/read.
   */
  private async ensurePlaygroundIcon(
    workspaceId: string,
    directory: string,
  ): Promise<void> {
    const source = resolveAppIconPath()
    if (!source) return

    // Read the source bytes once and trim the transparent safe-area
    // margin *in memory*. The source file is only ever read here —
    // never written — so the true app icon on disk is untouched.
    let bytes: Buffer
    try {
      bytes = trimTransparentMargin(await fsp.readFile(source))
    } catch (err) {
      console.warn("[playground] failed to read app icon:", err)
      return
    }

    // 1. Drop the trimmed icon into the project folder (a separate
    //    file from the source asset). `wx` so we never clobber a
    //    real icon the user dropped in.
    const dest = path.join(directory, PLAYGROUND_ICON_NAME)
    try {
      await fsp.writeFile(dest, bytes, { flag: "wx" })
    } catch (err) {
      const e = err as NodeJS.ErrnoException
      if (e?.code !== "EEXIST") {
        console.warn("[playground] failed to write app icon:", err)
      }
    }

    // 2. Set it as the workspace's auto icon. A user upload always
    //    wins, so bail if one exists. Otherwise (re)derive ours —
    //    this also upgrades a previously-stored untrimmed icon.
    const ws = this.ctx.db.client.readRoot().app.workspaces[workspaceId]
    if (!ws || ws.icon) return

    // Already up to date? Compare against the current auto blob so
    // we don't churn a new blob on every boot.
    const prevBlobId = ws.iconAuto?.blobId ?? null
    if (prevBlobId) {
      try {
        const existing = await this.ctx.db.client.getBlobData(prevBlobId)
        if (existing && Buffer.from(existing as Uint8Array).equals(bytes)) {
          return
        }
      } catch {
        // Can't read the old blob — fall through and replace it.
      }
    }

    const blobId = await this.ctx.db.client.createBlob(
      new Uint8Array(bytes),
      true,
    )
    await this.ctx.db.client.update(root => {
      const w = root.app.workspaces[workspaceId]
      if (!w) return
      // A user uploaded an icon while we worked — keep theirs.
      if (w.icon) {
        void this.ctx.db.client.deleteBlob(blobId).catch(() => {})
        return
      }
      w.iconAuto = {
        blobId,
        mimeType: "image/png",
        sourcePath: PLAYGROUND_ICON_NAME,
        discoveredAt: Date.now(),
      }
      w.iconAutoAttempted = true
    })
    // Drop the superseded blob now that the new one is referenced.
    if (prevBlobId && prevBlobId !== blobId) {
      void this.ctx.db.client.deleteBlob(prevBlobId).catch(() => {})
    }
  }

  /**
   * `git init` over the seeded folder when git is available.
   * `stageInitialFiles: false` leaves the sample files untracked
   * so they show as pending changes in the Git sidebar.
   * Best-effort and idempotent.
   */
  private async gitInitIfAvailable(directory: string): Promise<void> {
    try {
      const gitAvailable = await this.ctx.repos.isGitInstalled()
      if (gitAvailable) {
        await this.ctx.repos.initRepoAtDirectory({
          directory,
          stageInitialFiles: false,
        })
      }
    } catch (err) {
      console.warn("[playground] git init for playground failed:", err)
    }
  }

  /**
   * Recreate the playground folder (sample files + git) if its
   * directory was deleted on disk. No-op when it's still there.
   */
  private async ensureExistingPlaygroundOnDisk(
    workspaceId: string,
  ): Promise<void> {
    const root = this.ctx.db.client.readRoot()
    const scope = Object.values(root.app.scopes).find(
      s => s.workspaceId === workspaceId && !s.archived,
    )
    if (!scope) return
    const directory = scope.directory
    if (fs.existsSync(directory)) return // still on disk — nothing to do

    try {
      await fsp.mkdir(directory, { recursive: true })
    } catch (err) {
      console.warn(
        "[playground] failed to recreate playground dir at %s:",
        directory,
        err,
      )
      return
    }
    await this.seedSampleFiles(directory)
    await this.gitInitIfAvailable(directory)
  }

  /**
   * Write a tiny sample project (README + a couple of Python
   * files) so the File-tree and Git sidebars have real content.
   * Best-effort; never overwrites existing files (`wx` flag).
   */
  private async seedSampleFiles(directory: string): Promise<void> {
    const files: Array<{ rel: string; body: string }> = [
      {
        rel: "README.md",
        body: [
          "# Zenbu Playground",
          "",
          "A scratch project that ships with Zenbu so you have",
          "somewhere to poke around on your first launch.",
          "",
          "Open the agent and ask it to change something — try",
          "\"make `main.py` greet the world in French\".",
          "",
        ].join("\n"),
      },
      {
        rel: "main.py",
        body: [
          "from greetings.hello import greet",
          "",
          "",
          'def main() -> None:',
          '    print(greet("world"))',
          "",
          "",
          'if __name__ == "__main__":',
          "    main()",
          "",
        ].join("\n"),
      },
      {
        rel: "greetings/__init__.py",
        body: "",
      },
      {
        rel: "greetings/hello.py",
        body: [
          'def greet(name: str) -> str:',
          '    """Return a friendly greeting for `name`."""',
          '    return f"Hello, {name}!"',
          "",
        ].join("\n"),
      },
    ]

    for (const file of files) {
      const abs = path.join(directory, file.rel)
      try {
        await fsp.mkdir(path.dirname(abs), { recursive: true })
        await fsp.writeFile(abs, file.body, { encoding: "utf8", flag: "wx" })
      } catch (err) {
        const e = err as NodeJS.ErrnoException
        if (e?.code === "EEXIST") continue
        console.warn("[playground] failed to seed %s:", file.rel, err)
      }
    }
  }

  /**
   * Ensure `~/zenbu-playground` exists. Returns its path plus a
   * `created` flag, or `null` (skip seeding) on failure.
   */
  private async ensurePlaygroundDirectory(): Promise<
    { directory: string; created: boolean } | null
  > {
    const home = os.homedir()
    if (!home) {
      console.warn(
        "[playground] no homedir resolvable, skipping playground seed",
      )
      return null
    }
    const directory = path.join(home, PLAYGROUND_DIR_NAME)
    try {
      if (fs.existsSync(directory)) {
        const stat = await fsp.stat(directory)
        if (!stat.isDirectory()) {
          console.warn(
            "[playground] %s exists but is not a directory, skipping seed",
            directory,
          )
          return null
        }
        return { directory, created: false }
      }
      await fsp.mkdir(directory, { recursive: true })
      return { directory, created: true }
    } catch (err) {
      console.warn(
        "[playground] failed to ensure playground directory at %s:",
        directory,
        err,
      )
      return null
    }
  }

  /**
   * Point the main window at the playground only if it's still on
   * the onboarding view (never overrides another choice).
   */
  private async pointMainWindowAtPlayground(
    workspaceId: string,
  ): Promise<void> {
    await this.ctx.db.client.update(root => {
      const ws = root.app.windowStates[MAIN_WINDOW_ID]
      if (ws && ws.activeView.kind !== "onboarding") return
      const fresh = ensureWindowState(root, MAIN_WINDOW_ID)
      if (fresh.activeView.kind !== "onboarding") return
      const scope = Object.values(root.app.scopes).find(
        s => s.workspaceId === workspaceId && !s.archived,
      )
      fresh.activeView = { kind: "workspace", workspaceId }
      if (scope) {
        fresh.selectedScopeId = scope.id
        fresh.workspaceActiveScope[workspaceId] = scope.id
      }
    })
  }
}

/** Inline mirror of the renderer's `ensureWindowState` (kept in
 * sync with the copy in `workspaces.ts`). */
function ensureWindowState(
  root: { app: { windowStates: Record<string, WindowState> } },
  windowId: string,
): WindowState {
  const existing = root.app.windowStates[windowId]
  if (existing) {
    if (!existing.scopeLastTerminal) existing.scopeLastTerminal = {}
    if (!existing.scopePanes) existing.scopePanes = {}
    if (!existing.workspaceActiveScope) existing.workspaceActiveScope = {}
    if (!existing.workspaceUiStates) existing.workspaceUiStates = {}
    if (!existing.scopeUiStates) existing.scopeUiStates = {}
    return existing
  }
  const fresh: WindowState = {
    selectedScopeId: null,
    scopeLastTerminal: {},
    activeView: { kind: "onboarding" },
    scopePanes: {},
    workspaceActiveScope: {},
    workspaceRailOpen: true,
    workspaceUiStates: {},
    scopeUiStates: {},
    pluginsView: { selectedPluginName: null, sidebarOpen: true },
    fullscreen: false,
  }
  root.app.windowStates[windowId] = fresh
  return fresh
}
