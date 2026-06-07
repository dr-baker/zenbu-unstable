import fs from "node:fs"
import fsp from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { spawnWithInstallHangGuard } from "@zenbujs/core/install-guard"
import { Service } from "@zenbujs/core/runtime"
import { RpcService } from "@zenbujs/core/services"
import { PaletteActionsService } from "../../../../app/src/main/services/palette-actions"
import { patchLocalPlugins } from "../lib/patch-local-plugins"

/**
 * Plugin-installer main service.
 *
 * Owns three responsibilities:
 *  1. Registers a command-palette action ("Install plugin from
 *     GitHub…"). The action's RPC handler is `openPrompt`, which
 *     just emits an event the content-script modal listens for.
 *  2. The `install` RPC: clone → `pnpm install` → patch
 *     `zenbu.plugins.local.jsonc`. Progress is streamed via events.
 *  3. The local-config transform itself (see `patchLocalPlugins`).
 */
const PLUGINS_HOME = path.join(os.homedir(), ".zenbu", "plugins")
const INTERNAL_PATHS_JSON = path.join(
  os.homedir(),
  ".zenbu",
  ".internal",
  "paths.json",
)
const execFileP = promisify(execFile)

export class PluginInstallerService extends Service.create({
  key: "pluginInstaller",
  deps: {
    rpc: RpcService,
    paletteActions: PaletteActionsService,
  },
}) {
  evaluate() {
    this.setup("register-palette-action", () => {
      const id = "plugin-installer:install"
      void this.ctx.paletteActions.register({
        id,
        label: "Install plugin from git repo…",
        hint: "install",
        // No `icon` field — the palette is label-only by design now.
        group: "Plugins",
        rpc: {
          plugin: "pluginInstaller",
          service: "pluginInstaller",
          method: "openPrompt",
        },
      })
      return () => {
        void this.ctx.paletteActions.unregister({ id })
      }
    })

    this.setup("inject-modal", () =>
      this.inject({
        name: "pluginInstaller/modal",
        modulePath: "./src/content/installer-modal.tsx",
      }),
    )
  }

  /**
   * Palette-action RPC handler. The renderer dispatch always passes
   * `{ windowId }`, which we forward so a multi-window setup can
   * (in the future) target the originating window.
   */
  async openPrompt(args: { windowId: string }): Promise<{ ok: true }> {
    this.ctx.rpc.emit.pluginInstaller.openPrompt({ windowId: args.windowId })
    return { ok: true }
  }

  /**
   * Clone + install + register. Reports progress through events.
   *
   * The caller can keep calling this if the URL is wrong / the
   * clone fails — we always clean up a half-created plugin
   * directory on error so the next attempt starts from scratch.
   */
  async install(args: {
    url: string
    name?: string
    commitSha?: string
    ref?: string
  }): Promise<{
    ok: true
    name: string
    path: string
  }> {
    const url = args.url.trim()
    if (!url) throw new Error("Empty URL.")

    const ref = args.ref?.trim() || undefined
    if (ref && !/^[A-Za-z0-9._/-]+$/.test(ref)) {
      throw new Error(`Invalid git ref "${ref}".`)
    }

    const explicitName =
      args.name === undefined ? undefined : args.name.trim()
    const name =
      explicitName === undefined ? derivePluginName(url) : explicitName
    if (!name) throw new Error(`Could not derive a plugin name from "${url}".`)
    if (!/^[A-Za-z0-9._-]+$/.test(name)) {
      throw new Error(`Invalid plugin name "${name}".`)
    }
    const commitSha = args.commitSha?.trim()
    if (commitSha && !/^[0-9a-f]{7,64}$/i.test(commitSha)) {
      throw new Error(`Invalid commit SHA "${commitSha}".`)
    }

    const dest = path.join(PLUGINS_HOME, name)
    const cleanupOnError = async () => {
      try {
        await fsp.rm(dest, { recursive: true, force: true })
      } catch {}
    }

    try {
      await fsp.mkdir(PLUGINS_HOME, { recursive: true })

      if (fs.existsSync(dest)) {
        // If something is already there but it isn't a usable
        // plugin (no manifest), nuke it and re-clone. If it IS a
        // plugin we assume the user wants a fresh copy — also
        // nuke and re-clone, since git refuses non-empty dirs.
        await fsp.rm(dest, { recursive: true, force: true })
      }

      this.emit("clone", `Cloning ${url}…`)
      // Marketplace installs pass `ref` ("released") so the clone tracks the
      // published branch instead of the author's `main` tip. The host's git
      // updater then fast-forwards that same branch on later update checks.
      const cloneArgs = ["clone", "--depth", "1"]
      if (ref) cloneArgs.push("--branch", ref)
      cloneArgs.push(url, dest)
      await this.run("git", cloneArgs)
      if (commitSha) {
        this.emit("clone", `Verifying approved commit ${commitSha}…`)
        const head = await gitStdout(dest, ["rev-parse", "HEAD"])
        if (!commitMatches(head, commitSha)) {
          throw new Error(
            `Marketplace approved commit ${commitSha} does not match cloned HEAD ${head}.`,
          )
        }
      }

      const manifest = path.join(dest, "zenbu.plugin.ts")
      const manifestJs = path.join(dest, "zenbu.plugin.js")
      if (!fs.existsSync(manifest) && !fs.existsSync(manifestJs)) {
        throw new Error(
          "Repo has no `zenbu.plugin.ts` at its root — not a Zenbu plugin.",
        )
      }

      this.emit("install", `Installing dependencies with pnpm…`)
      const pnpm = resolvePnpm()
      await this.run(pnpm, ["install", "--prefer-offline"], { cwd: dest })

      this.emit("register", `Registering with zenbu.plugins.local.jsonc…`)
      const manifestPath = fs.existsSync(manifest) ? manifest : manifestJs
      const projectDir = projectRootFromService()
      await patchLocalPlugins(projectDir, manifestPath)

      this.ctx.rpc.emit.pluginInstaller.installComplete({
        name,
        path: dest,
      })
      return { ok: true, name, path: dest }
    } catch (err) {
      await cleanupOnError()
      const message = err instanceof Error ? err.message : String(err)
      this.ctx.rpc.emit.pluginInstaller.installError({ message })
      throw err
    }
  }

  // ---- internals ---------------------------------------------------

  private emit(
    phase: "clone" | "install" | "register" | "log",
    message: string,
  ) {
    this.ctx.rpc.emit.pluginInstaller.installProgress({ phase, message })
  }

  /**
   * Spawn a child command and surface every output line as an
   * `installProgress` event. For `pnpm install` we route through
   * `spawnWithInstallHangGuard` from the framework, which transparently
   * detects + survives the post-"Done" pnpm hang and appends an
   * incident to `~/.zenbu/.internal/install-incidents.log`.
   */
  private async run(
    cmd: string,
    argv: string[],
    opts: { cwd?: string } = {},
  ): Promise<void> {
    const isPnpm = /(^|[\\/])pnpm(\W|$)/i.test(cmd)
    await spawnWithInstallHangGuard({
      bin: cmd,
      args: argv,
      cwd: opts.cwd ?? process.cwd(),
      env: process.env,
      pmType: isPnpm ? "pnpm" : undefined,
      label: `${cmd} ${argv.join(" ")}`,
      onLine: (line) => this.emit("log", line),
    })
  }
}
async function gitStdout(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileP("git", args, {
    cwd,
    maxBuffer: 1024 * 1024,
  })
  return stdout.trim()
}

function commitMatches(head: string, expected: string): boolean {
  const normalizedHead = head.trim().toLowerCase()
  const normalizedExpected = expected.trim().toLowerCase()
  return (
    normalizedHead === normalizedExpected ||
    normalizedHead.startsWith(normalizedExpected)
  )
}

/* The local-config patch helpers moved to ../lib/patch-local-plugins.ts.
   This service imports them so the on-disk format stays consistent
   with the rest of the JSONC manifest tooling. */

/* -------------------------------------------------------------------------- */
/*                                  helpers                                   */
/* -------------------------------------------------------------------------- */

/**
 * Derive a sensible directory name from a git URL. Strips `.git`
 * and any trailing path delimiter. Handles `https://…/owner/repo`,
 * `git@github.com:owner/repo`, and `owner/repo` (GitHub shorthand).
 */
function derivePluginName(url: string): string | null {
  let s = url.trim()
  s = s.replace(/\.git$/i, "")
  s = s.replace(/\/$/, "")
  // git@host:owner/repo style → use the last segment after ":" or "/"
  const lastSlash = s.lastIndexOf("/")
  const lastColon = s.lastIndexOf(":")
  const idx = Math.max(lastSlash, lastColon)
  if (idx === -1) return null
  const name = s.slice(idx + 1)
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return null
  return name
}

/**
 * Locate the bundled pnpm. The launcher writes the toolchain paths
 * to `~/.zenbu/.internal/paths.json` on boot; we read from there.
 * Fall back to `pnpm` on $PATH if for any reason the file isn't
 * there (e.g. dev mode without the launcher).
 */
function resolvePnpm(): string {
  try {
    const raw = fs.readFileSync(INTERNAL_PATHS_JSON, "utf8")
    const parsed = JSON.parse(raw) as { pnpmPath?: string }
    if (parsed.pnpmPath && fs.existsSync(parsed.pnpmPath))
      return parsed.pnpmPath
  } catch {}
  return "pnpm"
}

/**
 * The project root we want to patch (`zenbu.plugins.local.jsonc` lives next
 * to `zenbu.config.ts`). At runtime the service has no direct
 * handle on it, so we walk up from `process.cwd()` until we find
 * a `zenbu.config.ts`.
 */
function projectRootFromService(): string {
  let dir = process.cwd()
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, "zenbu.config.ts"))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return process.cwd()
}
