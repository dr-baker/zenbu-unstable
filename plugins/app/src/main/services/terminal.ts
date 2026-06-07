import { createRequire } from "node:module"
import path from "node:path"
import { Service } from "@zenbujs/core/runtime"
import {
  DbService,
  RpcService,
} from "@zenbujs/core/services"
import { nanoid } from "nanoid"
import { ShellEnvService } from "./shell-env"

type IPty = {
  pid: number
  onData: (cb: (data: string) => void) => void
  onExit: (cb: (e: { exitCode: number; signal?: number }) => void) => void
  write: (data: string) => void
  resize: (cols: number, rows: number) => void
  kill: (signal?: string) => void
}

type SpawnFn = (
  shell: string,
  args: string[],
  opts: {
    name: string
    cols: number
    rows: number
    cwd: string
    env: NodeJS.ProcessEnv
  },
) => IPty

const require = createRequire(import.meta.url)

/** Output retained per pty so newly-attached clients can hydrate their xterm
 * with what was already written. Keep this comfortably bigger than one screen
 * but small enough that we don't hoard memory for backgrounded terminals. */
const REPLAY_BUFFER_BYTES = 256 * 1024

/** How often we flush pending title changes back to the DB. Many shells emit
 * OSC sequences on every prompt redraw, so we coalesce. */
const TITLE_FLUSH_DELAY_MS = 150

type TerminalEntry = {
  id: string
  scopeId: string
  cwd: string
  pty: IPty
  /** Append-only chunks of recent pty output, capped at REPLAY_BUFFER_BYTES. */
  buffer: string[]
  bufferBytes: number
  /** Monotonic counter that increments once per `pty.onData` chunk.
   * Mirrored on the event payload + reported back from `attach()` as
   * `lastSeq`, so the renderer can dedupe events that overlap with
   * the replay buffer. */
  seq: number
  /** Last title pushed to the DB (used to dedupe writes). */
  lastTitle: string
  pendingTitle: string | null
  titleFlushTimer: ReturnType<typeof setTimeout> | null
}

/**
 * Owns @lydell/node-pty sessions keyed by terminal id. The DB stores the
 * list of terminals and their titles; this service is the live process
 * registry. We use `@lydell/node-pty` (rather than vanilla `node-pty`)
 * because it ships prebuilds that work inside Electron's runtime without
 * a per-user native rebuild step.
 */
export class TerminalService extends Service.create({
  key: "terminal",
  deps: {
    rpc: RpcService,
    db: DbService,
    shellEnv: ShellEnvService,
  },
}) {
  private readonly terminals = new Map<string, TerminalEntry>()
  private spawn!: SpawnFn

  evaluate() {
    const pty = require("@lydell/node-pty") as { spawn: SpawnFn }
    this.spawn = pty.spawn

    // The bottom-panel "Terminal" view is contributed by the
    // `@zenbu/terminal` plugin (a `rendering: "component"`
    // view). This service stays focused on the PTY lifecycle + DB
    // state; the plugin drives the UI via the RPCs + events below.

    this.setup("dispose-all", () => async () => {
      await Promise.all(
        [...this.terminals.values()].map(entry => this.killEntry(entry)),
      )
      this.terminals.clear()
    })
  }

  /** Create a new terminal record for `scopeId` rooted at `cwd`. Spawns the
   * pty up front so the title can start tracking immediately. Returns the
   * new terminalId. */
  async create(args: {
    scopeId: string
    cwd: string
    cols?: number
    rows?: number
  }): Promise<{ terminalId: string }> {
    const terminalId = nanoid()
    const initialTitle = defaultTitle(args.cwd)
    await this.ctx.db.client.update(root => {
      root.app.terminals[terminalId] = {
        id: terminalId,
        scopeId: args.scopeId,
        cwd: args.cwd,
        title: initialTitle,
        createdAt: Date.now(),
      }
    })
    await this.spawnFor(terminalId, args.scopeId, args.cwd, initialTitle, {
      cols: args.cols,
      rows: args.rows,
    })
    return { terminalId }
  }

  /** Attach to an existing terminal, spawning the underlying pty lazily if
   * it hasn't been started in this process (e.g. fresh launch with restored
   * DB state). Returns a replay string of the most recent output plus the
   * `lastSeq` that replay corresponds to, so the renderer can drop any
   * concurrently-arriving `terminalData` events whose `seq` is already in
   * the replay. */
  async attach(args: {
    terminalId: string
    cols?: number
    rows?: number
  }): Promise<{
    terminalId: string
    cwd: string
    replay: string
    lastSeq: number
  }> {
    let entry = this.terminals.get(args.terminalId)
    if (!entry) {
      const record = this.ctx.db.client.readRoot().app.terminals[args.terminalId]
      if (!record) throw new Error(`terminal ${args.terminalId} does not exist`)
      entry = await this.spawnFor(record.id, record.scopeId, record.cwd, record.title, {
        cols: args.cols,
        rows: args.rows,
      })
    } else if (args.cols != null && args.rows != null) {
      const cols = Math.max(1, Math.floor(args.cols))
      const rows = Math.max(1, Math.floor(args.rows))
      try {
        entry.pty.resize(cols, rows)
      } catch {}
    }
    // Trim the leading partial line: the rolling buffer is byte-
    // capped, not line-aligned, so its first bytes are typically
    // mid-line. Writing them verbatim into a fresh xterm leaves
    // garbage characters and a stray zsh PROMPT_EOL_MARK (the
    // little `%` in reverse video) at the top-left on every
    // attach. Skipping to the first `\n` gives the replay a clean
    // line-aligned start. If the buffer happens to have no
    // newlines at all (very rare — a single short partial line),
    // fall through and send it as-is.
    let replay = entry.buffer.join("")
    const firstNl = replay.indexOf("\n")
    if (firstNl >= 0 && firstNl < replay.length - 1) {
      replay = replay.slice(firstNl + 1)
    }
    return {
      terminalId: entry.id,
      cwd: entry.cwd,
      replay,
      lastSeq: entry.seq,
    }
  }

  async write(args: { terminalId: string; data: string }) {
    const entry = this.terminals.get(args.terminalId)
    if (!entry) return
    try {
      entry.pty.write(args.data)
    } catch {}
  }

  async resize(args: { terminalId: string; cols: number; rows: number }) {
    const entry = this.terminals.get(args.terminalId)
    if (!entry) return
    const cols = Math.max(1, Math.floor(args.cols))
    const rows = Math.max(1, Math.floor(args.rows))
    try {
      entry.pty.resize(cols, rows)
    } catch {}
  }

  /** Kill the pty and remove the terminal from the DB. We delete the DB
   * record first so the renderer's tab disappears immediately even if the
   * pty teardown takes a moment (or hangs); the pty kill happens
   * unawaited afterwards. */
  async dispose(args: { terminalId: string }) {
    await this.ctx.db.client.update(root => {
      // NOTE: `delete root.app.terminals[id]` looks correct but is a
      // silent no-op against kyju's recording proxy — the proxy has
      // `get`/`set` traps but no `deleteProperty` trap, so the
      // `delete` mutates the local snapshot without emitting an op.
      // Other replicas never hear about it and the local snapshot is
      // overwritten on the next round-trip. We work around this by
      // *assigning* a fresh object that omits the deleted key, which
      // routes through the `set` trap and is recorded as a single
      // `root.set` op at the parent path. Same pattern for the
      // `scopeLastTerminal` cleanup below.
      const nextTerminals = { ...root.app.terminals }
      delete nextTerminals[args.terminalId]
      root.app.terminals = nextTerminals
      for (const ws of Object.values(root.app.windowStates)) {
        const map = ws.scopeLastTerminal
        if (!map) continue
        let changed = false
        const nextMap: Record<string, string> = {}
        for (const scopeId of Object.keys(map)) {
          if (map[scopeId] === args.terminalId) {
            changed = true
            continue
          }
          nextMap[scopeId] = map[scopeId]!
        }
        if (changed) ws.scopeLastTerminal = nextMap
      }
    })
    const entry = this.terminals.get(args.terminalId)
    if (entry) {
      this.terminals.delete(args.terminalId)
      this.killEntry(entry).catch(err =>
        console.error("[terminal] killEntry failed:", err),
      )
    }
  }

  /** Kill every terminal belonging to any scope in `scopeIds`. Called on
   * workspace/scope deletion so we don't leak ptys. */
  async disposeForScopes(args: { scopeIds: string[] }) {
    const set = new Set(args.scopeIds)
    const root = this.ctx.db.client.readRoot()
    const toDispose = Object.values(root.app.terminals)
      .filter(t => set.has(t.scopeId))
      .map(t => t.id)
    for (const id of toDispose) {
      await this.dispose({ terminalId: id })
    }
  }

  private async spawnFor(
    terminalId: string,
    scopeId: string,
    cwd: string,
    currentTitle: string,
    sizing: { cols?: number; rows?: number },
  ): Promise<TerminalEntry> {
    const shell = pickShell()
    // login-shell env so PATH etc. match a real terminal
    const baseEnv = await this.ctx.shellEnv.getEnv()
    const pty = this.spawn(shell, [], {
      name: "xterm-256color",
      cols: sizing.cols ?? 80,
      rows: sizing.rows ?? 24,
      cwd,
      env: {
        ...baseEnv,
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
      },
    })

    const entry: TerminalEntry = {
      id: terminalId,
      scopeId,
      cwd,
      pty,
      buffer: [],
      bufferBytes: 0,
      seq: 0,
      lastTitle: currentTitle,
      pendingTitle: null,
      titleFlushTimer: null,
    }
    this.terminals.set(terminalId, entry)

    pty.onData(data => {
      entry.buffer.push(data)
      entry.bufferBytes += data.length
      while (
        entry.bufferBytes > REPLAY_BUFFER_BYTES &&
        entry.buffer.length > 1
      ) {
        const dropped = entry.buffer.shift()!
        entry.bufferBytes -= dropped.length
      }
      entry.seq += 1
      const title = extractTitle(data)
      if (title != null) this.scheduleTitleUpdate(entry, title)
      this.ctx.rpc.emit.app.terminalData({ terminalId, data, seq: entry.seq })
    })
    pty.onExit(({ exitCode, signal }) => {
      this.ctx.rpc.emit.app.terminalExit({
        terminalId,
        exitCode,
        signal: signal ?? 0,
      })
      this.terminals.delete(terminalId)
    })

    return entry
  }

  private scheduleTitleUpdate(entry: TerminalEntry, title: string) {
    if (!title || title === entry.lastTitle) return
    entry.pendingTitle = title
    if (entry.titleFlushTimer) return
    entry.titleFlushTimer = setTimeout(() => {
      entry.titleFlushTimer = null
      const next = entry.pendingTitle
      entry.pendingTitle = null
      if (!next || next === entry.lastTitle) return
      entry.lastTitle = next
      void this.ctx.db.client.update(root => {
        const record = root.app.terminals[entry.id]
        if (!record) return
        record.title = next
      })
    }, TITLE_FLUSH_DELAY_MS)
  }

  private async killEntry(entry: TerminalEntry): Promise<void> {
    if (entry.titleFlushTimer) {
      clearTimeout(entry.titleFlushTimer)
      entry.titleFlushTimer = null
    }
    return new Promise<void>(resolve => {
      let settled = false
      const done = () => {
        if (settled) return
        settled = true
        resolve()
      }
      try {
        entry.pty.onExit(done)
        entry.pty.kill()
      } catch {
        done()
      }
    })
  }
}

function pickShell(): string {
  if (process.platform === "win32") {
    return process.env.COMSPEC || "powershell.exe"
  }
  return process.env.SHELL || "/bin/bash"
}

function defaultTitle(cwd: string): string {
  const base = path.basename(cwd)
  return base || cwd || "terminal"
}

/** Pull the last OSC 0 / OSC 1 / OSC 2 title-set sequence out of a chunk
 * of pty output. We only care about the most recent one because shells
 * tend to rewrite the title on every prompt. Both BEL (\x07) and ST
 * (\x1b\\) terminators are supported. */
function extractTitle(chunk: string): string | null {
  let match: string | null = null
  const re = /\x1b\][012];([^\x07\x1b]*)(?:\x07|\x1b\\)/g
  for (;;) {
    const next = re.exec(chunk)
    if (!next) break
    match = next[1] ?? null
  }
  if (match == null) return null
  return match.trim()
}
