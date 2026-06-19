import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { Compartment, EditorState, Prec, type Extension } from "@codemirror/state"
import {
  EditorView,
  keymap,
  placeholder as cmPlaceholder,
  drawSelection,
} from "@codemirror/view"
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands"
import { useDbClient, useEvents, useInjections, useRpc } from "@zenbujs/core/react"
import type { ImageContent } from "@earendil-works/pi-ai"
import { subscribeFocusComposer } from "@/lib/focus-composer"
import {
  composerThemeFeature,
  detectTrigger,
  formatBlobMarker,
  getPills,
  pillsFeature,
  setDbClientEffect,
  setFileIndexEffect,
} from "./cm"
import { FilePickerMenu } from "./file-picker-menu"
import { SlashCommandMenu } from "./slash-command-menu"
import { ComposerToolbar, type AgentConfig } from "./composer-toolbar"
import { rankEntries } from "./lib/fuzzy"
import { getImageBytes } from "./lib/image-cache"
import { downscaleImage } from "./lib/downscale-image"
import type { ComposerIntent, FileEntry, SlashCommand } from "./types"

export type ComposerSubmitPayload = {
  /** Final wire text shipped to the model. File pills are inlined as
   * `@<filePath>`; image pills are emitted as
   * `@blob:<id>{order=N, size=BYTES}` markers — same underlying token
   * as the input, with positional + size metadata appended so the
   * model can correlate the marker with the attached image parts. */
  text: string
  /** Verbatim composer doc text — the same value the user sees in the
   * input. Used for persistence and for re-rendering the user message
   * read-only with pill widgets. Image refs survive as `@blob:<id>`
   * (without metadata); file refs as `@<filePath>`. */
  displayText: string
  /** Image attachments in document order, ready to forward as
   * pi's `PromptOptions.images`. */
  images: ImageContent[]
  /** Image references for persistence/replay (blob refs survive across
   * reload; the bytes/base64 in `images` do not need to). Same order
   * as `images`. */
  imageRefs: { blobId: string; mimeType: string }[]
  /** User intent for this submission:
   *   default   — parent picks based on streaming state + the user's
   *               configured default send mode
   *   steer     — Mod+Enter, or `/steer` slash
   *   followUp  — `/queue` slash
   * The composer only resolves the override; whether to ship as a
   * prompt or enqueue is the parent's call. */
  intent: ComposerIntent
}

export type ComposerProps = {
  /** Unique key for the editor instance; remount when this changes. */
  composerKey?: string
  onSubmit: (payload: ComposerSubmitPayload) => void
  placeholder?: string
  /** Seeded doc text. Read once at mount only — the composer is
   * uncontrolled. Pair with `composerKey` to remount on chat switch. */
  initialText?: string
  /** Fired on every doc change with the full doc text. Use this to
   * persist drafts; the caller is responsible for debouncing. */
  onDraftChange?: (text: string) => void
  /** Static file list for the `@`-mention typeahead. */
  files?: FileEntry[]
  /** Static slash command list for the `/` typeahead. */
  slashCommands?: SlashCommand[]
  onSlashAction?: (action: string) => void
  agentConfigs?: AgentConfig[]
  currentAgentConfigId?: string
  onChangeAgentConfig?: (id: string) => void
  currentModel?: string
  onChangeModel?: (value: string) => void
  currentThinkingLevel?: string
  onChangeThinkingLevel?: (value: string) => void
  streaming?: boolean
  onInterrupt?: () => void
  /** When true, Enter inserts a newline instead of submitting and the
   * toolbar shows a lock button in place of the interrupt button. */
  locked?: boolean
  onUnlock?: () => void
  toolbarSlot?: ReactNode
  /** Read-only mode — disables editing, the keymap, the typeahead, the
   * paste handler, and the toolbar. Used by the user-message bubble to
   * re-render the persisted input with the same pill decorations the
   * user typed it with. */
  readOnly?: boolean
  /** Chromeless mount: skip the outer max-width wrapper, the rounded
   * border + `bg-card` background, and the toolbar. The composer
   * inherits its container's background and padding so it visually
   * fuses with the surrounding surface. Used by the user-message
   * bubble's inline-edit mode so the live editor stays on the
   * `bg-accent` chip instead of stamping its own `bg-card` rectangle
   * on top of it. Independent of `readOnly`: an embedded composer
   * can still be fully interactive. */
  embedded?: boolean
  /** Stable identifier for this composer instance. When set, the
   * composer subscribes to the `appendComposerDraft` event and
   * appends matching payloads to its doc (without clobbering the
   * current draft). Used by the user-message bubble's revert flow
   * to drop the past message's text into the live composer. */
  composerId?: string
  /** When true, the entire seeded doc is selected on mount so any
   * keystroke replaces it. Used by inline-edit flows (user-message
   * bubble, queued-message row) to make the "you're editing, type
   * to replace" affordance obvious. Ignored when `readOnly`. */
  selectAllOnMount?: boolean
  /** Extra CodeMirror extensions contributed by renderer advice.
   * This keeps the input surface extensible without hard-coding
   * plugin behavior into the host composer. */
  codeMirrorExtensions?: readonly Extension[]
}

const DEFAULT_PLACEHOLDER = "/ for commands, @ for context"
const MAX_FILE_RESULTS = 200
const MAX_SLASH_RESULTS = 200

// React <Activity> keeps components mounted while hidden, but tears down
// effects. CodeMirror lives inside an effect, so tab switches destroy and
// recreate the EditorView without a React render in between. Keep an
// in-memory copy keyed by composerKey so a hidden→visible tab restores the
// latest text immediately instead of relying on the debounced DB draft write.
const liveDraftsByComposerKey = new Map<string, string>()

function seedForComposerKey(composerKey: string, fallback: string): string {
  return liveDraftsByComposerKey.get(composerKey) ?? fallback
}

function rememberComposerDraft(composerKey: string, text: string): void {
  if (text.length === 0) {
    liveDraftsByComposerKey.delete(composerKey)
  } else {
    liveDraftsByComposerKey.set(composerKey, text)
  }
}

type MenuAnchor = { left: number; top: number; bottom: number }
type FileMenuState = {
  kind: "file"
  options: FileEntry[]
  from: number
  to: number
  /** Current query string — used to detect "query changed, reset selection". */
  query: string
  anchor: MenuAnchor | null
}
type SlashMenuState = {
  kind: "slash"
  options: SlashCommand[]
  from: number
  to: number
  query: string
}
type MenuState = FileMenuState | SlashMenuState | null

/**
 * Get the viewport coordinate of a doc position. Returns null when CM
 * can't measure (e.g. position is offscreen). Used to anchor the file
 * picker menu to the caret.
 */
function caretAnchor(
  view: EditorView,
  pos: number,
): { left: number; top: number; bottom: number } | null {
  const coords = view.coordsAtPos(pos)
  if (!coords) return null
  return { left: coords.left, top: coords.top, bottom: coords.bottom }
}

/**
 * Walk pills in document order and lower the editor state into pi's
 * wire format.
 *
 * - File pills: the in-doc text is *already* `@<filePath>`, so we just
 *   copy the slice as-is. No splicing required.
 * - Image pills: the in-doc text is `@blob:<id>` (TODO(zenbu): blob-
 *   path placeholder). We replace each occurrence with a positional
 *   marker `[Image #N]` and emit an `ImageContent` part with the bytes
 *   from the renderer-local image cache.
 *
 * Async because we downscale every image at send time per Anthropic's
 * sizing guidance — longest edge ≤ 1568px, JPEG re-encode at q=0.9.
 * See `lib/downscale-image.ts` for the rationale. The original bytes
 * stay in the renderer-local cache + blob store so the composer pill
 * and chat scrollback keep showing the user's full-resolution paste;
 * only the wire payload is reduced.
 */
type SerializedDoc = Omit<ComposerSubmitPayload, "intent">

async function serializeForSubmit(
  state: EditorState,
): Promise<SerializedDoc> {
  const doc = state.doc.toString()
  const pills = getPills(state).slice().sort((a, b) => a.from - b.from)
  if (pills.length === 0) {
    return { text: doc, displayText: doc, images: [], imageRefs: [] }
  }

  // First pass (sync): walk pills, build displayText, and collect the
  // raw image bytes we need to downscale. We stage the wire `text` as
  // an array of fragments because image markers depend on the post-
  // downscale byte size, which we only learn after the async pass.
  type Fragment = string | { kind: "image-marker"; index: number }
  const fragments: Fragment[] = []
  let displayText = ""
  let cursor = 0
  type RawImage = { blobId: string; bytes: Uint8Array; mimeType: string }
  const raw: RawImage[] = []
  for (const p of pills) {
    if (p.from > cursor) {
      const between = state.doc.sliceString(cursor, p.from)
      fragments.push(between)
      displayText += between
    }
    if (p.kind === "file" || p.kind === "upload") {
      // File and upload pills both round-trip as their literal doc
      // slice — `@<filePath>` or `@upload:<encodedPath>` — so the
      // wire text and the persisted displayText match what the user
      // sees in the input. The model can decode the upload token's
      // path if it needs the original spelling.
      const slice = state.doc.sliceString(p.from, p.to)
      fragments.push(slice)
      displayText += slice
    } else {
      displayText += `@blob:${p.blobId}`
      const cached = getImageBytes(p.blobId)
      if (cached) {
        const idx = raw.length
        raw.push({
          blobId: p.blobId,
          bytes: cached.bytes,
          mimeType: cached.mimeType,
        })
        fragments.push({ kind: "image-marker", index: idx })
      } else {
        // Cache miss is unexpected — the paste handler always populates
        // before adding the pill. Log loudly and emit a bare marker so
        // the wire text still references the blob id.
        console.warn(`[composer] no cached bytes for blob ${p.blobId}`)
        fragments.push(`@blob:${p.blobId}`)
      }
    }
    cursor = p.to
  }
  if (cursor < state.doc.length) {
    const tail = state.doc.sliceString(cursor)
    fragments.push(tail)
    displayText += tail
  }

  // Second pass (async): downscale each image in parallel. `Promise.all`
  // is fine here — a typical send has ≤ a handful of images and they
  // share the same Chromium decoder pool.
  const downscaled = await Promise.all(
    raw.map(r => downscaleImage(r.bytes, r.mimeType)),
  )

  // Stitch the final wire text now that we know each image's post-
  // downscale size.
  const images: ImageContent[] = []
  const imageRefs: { blobId: string; mimeType: string }[] = []
  let text = ""
  for (const f of fragments) {
    if (typeof f === "string") {
      text += f
      continue
    }
    const r = raw[f.index]!
    const d = downscaled[f.index]!
    images.push({
      type: "image",
      data: bytesToBase64(d.bytes),
      mimeType: d.mimeType,
    })
    // `imageRefs` is for persistence/replay against the blob store —
    // keep the *original* mime so future hydration matches the bytes
    // sitting in the cache and on disk.
    imageRefs.push({ blobId: r.blobId, mimeType: r.mimeType })
    text += formatBlobMarker(r.blobId, {
      order: f.index + 1,
      size: d.bytes.byteLength,
    })
  }
  return { text, displayText, images, imageRefs }
}

/** Browser-safe Uint8Array → base64. Chunked to avoid call-stack limits
 * on `String.fromCharCode.apply` for large images. */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = ""
  const chunk = 0x8000
  for (let i = 0; i < bytes.byteLength; i += chunk) {
    const slice = bytes.subarray(i, i + chunk)
    binary += String.fromCharCode.apply(
      null,
      slice as unknown as number[],
    )
  }
  return btoa(binary)
}

export function Composer({
  composerKey = "composer",
  onSubmit,
  placeholder = DEFAULT_PLACEHOLDER,
  initialText,
  onDraftChange,
  files = [],
  slashCommands = [],
  onSlashAction,
  agentConfigs,
  currentAgentConfigId,
  onChangeAgentConfig,
  currentModel,
  onChangeModel,
  currentThinkingLevel,
  onChangeThinkingLevel,
  streaming,
  onInterrupt,
  locked,
  onUnlock,
  toolbarSlot,
  readOnly,
  embedded,
  composerId,
  selectAllOnMount,
  codeMirrorExtensions = [],
}: ComposerProps) {
  // Plugin-contributed CodeMirror extensions, sourced from the
  // renderer function registry. Two kinds:
  //
  //   - `cm.composer-extension` — applied to every composer,
  //     including readOnly user-message renders. Use this for
  //     things that are purely visual (markdown live-preview,
  //     active-line decorations).
  //
  //   - `cm.composer-extension-editable` — applied only when the
  //     composer is editable. Use this for anything that needs an
  //     interactive editor (vim mode + its fat cursor, paste
  //     handlers, keymaps).
  //
  // The `codeMirrorExtensions` prop is a legacy advice surface and
  // is treated like the editable kind so a `readOnly` composer
  // never picks up extensions that don't make sense for it.
  const alwaysContributed = useInjections<Extension>({
    kind: "cm.composer-extension",
  })
  // Markdown live-preview lives in its own surface-agnostic slot
  // (also consumed by the standalone MarkdownEditor). Applied to
  // every composer, including readOnly renders.
  const markdownContributed = useInjections<Extension>({
    kind: "cm.markdown-extension",
  })
  const editableContributed = useInjections<Extension>({
    kind: "cm.composer-extension-editable",
  })
  const mergedContributed = useMemo<readonly Extension[]>(() => {
    const out: Extension[] = []
    for (const entry of alwaysContributed) out.push(entry.value)
    for (const entry of markdownContributed) out.push(entry.value)
    if (!readOnly) {
      out.push(...(codeMirrorExtensions ?? []))
      for (const entry of editableContributed) out.push(entry.value)
    }
    return out
  }, [
    codeMirrorExtensions,
    alwaysContributed,
    markdownContributed,
    editableContributed,
    readOnly,
  ])
  const readOnlyRef = useRef(readOnly)
  readOnlyRef.current = readOnly
  const embeddedRef = useRef(embedded)
  embeddedRef.current = embedded
  const selectAllOnMountRef = useRef(selectAllOnMount)
  selectAllOnMountRef.current = selectAllOnMount
  const codeMirrorExtensionsRef = useRef(mergedContributed)
  codeMirrorExtensionsRef.current = mergedContributed
  // Lives across re-renders so plugin-contributed extensions can be
  // reconfigured into a mounted EditorView without remounting. The
  // effect below dispatches `compartment.reconfigure(...)` whenever
  // the contributed array changes.
  const contributedCompartmentRef = useRef<Compartment | null>(null)
  if (!contributedCompartmentRef.current) {
    contributedCompartmentRef.current = new Compartment()
  }
  // Captured once per mount via refs. `initialText` is intentionally
  // not in the mount effect's deps — changing chats remounts via
  // `composerKey`, so the latest value is always read on fresh mount.
  const initialTextRef = useRef(initialText)
  initialTextRef.current = initialText
  const onDraftChangeRef = useRef(onDraftChange)
  onDraftChangeRef.current = onDraftChange
  // Tracks the last composerKey we actually acted on. We can't use
  // useEffect's deps alone to detect "key really changed": React's
  // <Activity> remounts effects on visibility toggles without
  // changing deps, which would otherwise run the reseed branch with
  // a stale initialTextRef and wipe the editor's preserved doc.
  const lastComposerKeyRef = useRef<string | null>(null)
  const composerKeyRef = useRef(composerKey)
  composerKeyRef.current = composerKey
  // Mirror `locked` into a ref so the Enter handler (defined once when
  // the editor mounts) always sees the latest value without rebuilding
  // the keymap on every render.
  const lockedRef = useRef(locked)
  lockedRef.current = locked
  // Same trick for the Ctrl-c interrupt binding: the keymap is built
  // once on mount, but `streaming` / `onInterrupt` change with every
  // render. Refs let the binding read the latest values without
  // rebuilding the EditorView.
  const streamingRef = useRef(streaming)
  streamingRef.current = streaming
  const onInterruptRef = useRef(onInterrupt)
  onInterruptRef.current = onInterrupt
  const hostRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const [menu, setMenu] = useState<MenuState>(null)
  const [selectedIndex, setSelectedIndex] = useState(0)

  const rpc = useRpc()
  const dbClient = useDbClient()
  // Kept in sync via a dispatched effect (see mount effect below)
  // so the image pill widget tree — which lives outside
  // <ZenbuProvider> — can hydrate blobs without `useDbClient`.
  const dbClientFieldRef = useRef(dbClient)
  dbClientFieldRef.current = dbClient

  const filesRef = useRef(files)
  const slashRef = useRef(slashCommands)
  const onSubmitRef = useRef(onSubmit)
  const onSlashActionRef = useRef(onSlashAction)
  const menuRef = useRef<MenuState>(menu)
  const selectedIndexRef = useRef(selectedIndex)
  filesRef.current = files
  slashRef.current = slashCommands
  onSubmitRef.current = onSubmit
  onSlashActionRef.current = onSlashAction
  menuRef.current = menu
  selectedIndexRef.current = selectedIndex

  const recomputeMenu = useMemo(
    () => (state: EditorState, view: EditorView | null) => {
      const trigger = detectTrigger(state)
      if (!trigger) {
        setMenu(null)
        setSelectedIndex(0)
        return
      }
      // Suppress the typeahead when the caret is inside an already-
      // recognized pill range. Without this, arrowing into a pill's
      // raw-text form (live preview) re-fires the menu with the
      // pill's contents as the query — noisy and useless. Boundary
      // at the left edge (`from`) is safe naturally because the @
      // is at the cursor, leaving nothing to walk back through.
      const head = state.selection.main.head
      const pills = getPills(state)
      for (const p of pills) {
        if (head > p.from && head <= p.to) {
          setMenu(null)
          setSelectedIndex(0)
          return
        }
      }
      const prev = menuRef.current
      // Same trigger run (same kind, same `@`/`/` position) AND same query
      // → user just moved the caret within the trigger region; preserve
      // their menu selection. Otherwise (query changed or trigger reset)
      // bounce selection to 0 so the top-ranked result is highlighted.
      const sameRun =
        prev != null &&
        prev.kind === trigger.kind &&
        prev.from === trigger.from &&
        prev.query === trigger.query

      if (trigger.kind === "file") {
        // Rank the full path; fuzzy.ts already biases the basename.
        const ranked = rankEntries(
          filesRef.current,
          trigger.query,
          f => f.path,
          MAX_FILE_RESULTS,
        )
        if (ranked.length === 0) {
          setMenu(null)
          setSelectedIndex(0)
          return
        }
        const anchor = view ? caretAnchor(view, trigger.from) : null
        setMenu({
          kind: "file",
          options: ranked.map(r => r.entry),
          from: trigger.from,
          to: trigger.to,
          query: trigger.query,
          anchor,
        })
        setSelectedIndex(
          sameRun ? i => Math.min(i, ranked.length - 1) : 0,
        )
      } else {
        const ranked = rankEntries(
          slashRef.current,
          trigger.query,
          c => `${c.label} ${c.id} ${c.group ?? ""} ${c.hint ?? ""} ${c.description ?? ""}`,
          MAX_SLASH_RESULTS,
        )
        if (ranked.length === 0) {
          setMenu(null)
          setSelectedIndex(0)
          return
        }
        setMenu({
          kind: "slash",
          options: ranked.map(r => r.entry),
          from: trigger.from,
          to: trigger.to,
          query: trigger.query,
        })
        setSelectedIndex(
          sameRun ? i => Math.min(i, ranked.length - 1) : 0,
        )
      }
    },
    [],
  )

  /**
   * Splice one or more `@upload:<absPath>` tokens at the current
   * caret. Mirrors how the typeahead inserts file pills — the doc
   * gets canonical text, decoration is derived. The path is
   * URL-encoded so the token has clean whitespace boundaries; the
   * widget decodes it for the visible chip.
   */
  const insertUploads = (paths: string[]) => {
    const view = viewRef.current
    if (!view || paths.length === 0) return
    const state = view.state
    const head = state.selection.main.head
    const before = head === 0 ? "" : state.doc.sliceString(head - 1, head)
    // Pills require a whitespace (or start-of-line) lookbehind on the `@`.
    // Add a leading space when the caret is mid-word so the inserted
    // token actually pillifies.
    const lead = head === 0 || /\s/.test(before) ? "" : " "
    const tokens = paths.map(p => `@upload:${encodeURI(p)}`)
    const insert = `${lead}${tokens.join(" ")} `
    view.dispatch({
      changes: { from: head, to: head, insert },
      selection: { anchor: head + insert.length },
      scrollIntoView: true,
      userEvent: "input",
    })
    view.focus()
  }

  const handleUploadClick = async () => {
    try {
      const result = await rpc.app.dialog.pickFiles()
      if (result.cancelled) return
      insertUploads(result.paths)
    } catch (err) {
      console.error("[composer] pickFiles failed:", err)
    }
  }

  const insertFile = (entry: FileEntry, from: number, to: number) => {
    const view = viewRef.current
    if (!view) return
    // The doc just gets the canonical text — `@<filePath>` followed by a
    // space. Decoration is derived from the doc contents, so the pill
    // appears automatically. No side state to update.
    const text = `@${entry.path}`
    const pillTo = from + text.length
    view.dispatch({
      changes: { from, to, insert: `${text} ` },
      selection: { anchor: pillTo + 1 },
    })
    setMenu(null)
    setSelectedIndex(0)
    view.focus()
  }

  const handleSlash = (cmd: SlashCommand, from: number, to: number) => {
    const view = viewRef.current
    if (!view) return
    if (cmd.submitWith !== undefined) {
      // Strip the slash trigger from the doc, then submit immediately
      // with the requested intent. The user never sees a sticky mode
      // — picking the command IS the send.
      view.dispatch({ changes: { from, to, insert: "" } })
      setMenu(null)
      setSelectedIndex(0)
      submit(view, cmd.submitWith)
      return
    }
    if (cmd.action) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: "" },
      })
      setMenu(null)
      setSelectedIndex(0)
      onSlashActionRef.current?.(cmd.action)
      view.focus()
      return
    }
    if (cmd.insertText) {
      view.dispatch({
        changes: { from, to, insert: cmd.insertText },
        selection: { anchor: from + cmd.insertText.length },
      })
    }
    setMenu(null)
    setSelectedIndex(0)
    view.focus()
  }

  const submit = (view: EditorView, override?: "steer" | "followUp") => {
    if (lockedRef.current) {
      // Locked composer: Enter falls through to "insert newline" so
      // the user can keep drafting without accidentally sending.
      view.dispatch(view.state.replaceSelection("\n"))
      return true
    }
    // Cheap sync guard against empty sends. A doc with whitespace +
    // no pills is a no-op; otherwise we commit to serializing.
    const state = view.state
    const docText = state.doc.toString()
    const hasPills = getPills(state).length > 0
    if (docText.trim().length === 0 && !hasPills) {
      return true
    }
    const intent: ComposerIntent = override ?? "default"
    // Clear the editor synchronously so the user sees the send fire
    // immediately. Downscaling can take ~10–100ms for a large screen-
    // shot; we don't want the input to feel laggy on Enter.
    view.dispatch({
      changes: { from: 0, to: state.doc.length, insert: "" },
    })
    // Snapshot the pre-clear state so the async serializer reads the
    // doc the user actually submitted, not the now-empty editor.
    void (async () => {
      try {
        const payload = await serializeForSubmit(state)
        if (
          payload.text.trim().length === 0 &&
          payload.images.length === 0
        ) {
          return
        }
        onSubmitRef.current({ ...payload, intent })
      } catch (err) {
        console.error("[composer] serialize failed:", err)
      }
    })()
    return true
  }

  const navigateMenu = (delta: number): boolean => {
    const current = menuRef.current
    if (!current) return false
    const len = current.options.length
    setSelectedIndex(i => (i + delta + len) % len)
    return true
  }

  const selectActiveMenuItem = (): boolean => {
    const current = menuRef.current
    if (!current) return false
    const idx = Math.min(selectedIndexRef.current, current.options.length - 1)
    if (current.kind === "file") {
      insertFile(current.options[idx]!, current.from, current.to)
    } else {
      handleSlash(current.options[idx]!, current.from, current.to)
    }
    return true
  }

  const completeActiveMenuItem = (): boolean => {
    const current = menuRef.current
    const view = viewRef.current
    if (!current || !view) return false
    const idx = Math.min(selectedIndexRef.current, current.options.length - 1)
    if (current.kind === "file") {
      insertFile(current.options[idx]!, current.from, current.to)
      return true
    }
    const cmd = current.options[idx]!
    const text = cmd.completionText ?? cmd.insertText ?? `/${cmd.label}`
    view.dispatch({
      changes: { from: current.from, to: current.to, insert: text },
      selection: { anchor: current.from + text.length },
      scrollIntoView: true,
      userEvent: "input",
    })
    view.focus()
    return true
  }

  const closeMenu = (): boolean => {
    if (!menuRef.current) return false
    setMenu(null)
    setSelectedIndex(0)
    return true
  }

  useEffect(() => {
    if (!hostRef.current) return

    const isReadOnly = readOnlyRef.current === true
    // Embedded composers borrow the readOnly bubble's tight padding +
    // collapsed min-height so the live editor doesn't stamp a tall
    // 74px rectangle on top of a snug user-message chip.
    const isCompact = isReadOnly || embeddedRef.current === true

    const composerKeymap = keymap.of([
      {
        key: "Enter",
        run: view => {
          if (selectActiveMenuItem()) return true
          return submit(view)
        },
        shift: () => false,
      },
      {
        key: "Mod-Enter",
        run: view => {
          // Steer override: interject mid-turn. Only meaningful when
          // streaming; when idle, parent treats it like a normal send.
          return submit(view, "steer")
        },
      },
      {
        key: "Shift-Enter",
        run: view => {
          // `scrollIntoView: true` keeps the caret visible when the
          // composer is at its max-height. Without it, regular typing
          // works (CM's input handler sets it implicitly) but this
          // manual dispatch leaves the new line off-screen until the
          // next keystroke nudges the scroller.
          view.dispatch({
            ...view.state.replaceSelection("\n"),
            scrollIntoView: true,
            userEvent: "input",
          })
          return true
        },
      },
      { key: "ArrowDown", run: () => navigateMenu(1) },
      { key: "ArrowUp", run: () => navigateMenu(-1) },
      { key: "Ctrl-n", run: () => navigateMenu(1) },
      { key: "Ctrl-p", run: () => navigateMenu(-1) },
      { key: "Tab", run: () => completeActiveMenuItem() },
      { key: "Escape", run: () => closeMenu() },
      {
        // todo: make this a native shortcut
       
        key: "Ctrl-c",
        run: view => {
          if (!streamingRef.current) return false
          if (!view.state.selection.main.empty) return false
          const cb = onInterruptRef.current
          if (!cb) return false
          cb()
          return true
        },
      },
    ])

    const updateListener = EditorView.updateListener.of(update => {
      // Doc edits can open, refine, or close the menu. Pure selection
      // changes (arrow keys, click-to-position) can only refine or
      // close an already-open menu — never spawn one. Without this
      // gate, arrowing into an existing `@something` would pop the
      // typeahead open even though the user is just navigating.
      if (update.docChanged) {
        recomputeMenu(update.state, update.view)
        // Notify owner so they can persist the draft. We pass the raw
        // doc string — pill structure re-derives from text on restore.
        const text = update.state.doc.toString()
        rememberComposerDraft(composerKeyRef.current, text)
        const cb = onDraftChangeRef.current
        if (cb) {
          console.log(
            `[composer] docChanged len=${text.length} userEvent=${update.transactions.some(t => t.isUserEvent("input") || t.isUserEvent("delete"))}`,
          )
          cb(text)
        }
      } else if (update.selectionSet && menuRef.current) {
        recomputeMenu(update.state, update.view)
      }
    })

    const theme = composerThemeFeature({
      compact: isCompact,
      readOnly: isReadOnly,
    })

    const seed = seedForComposerKey(composerKey, initialTextRef.current ?? "")
    // Plugin-contributed extensions live inside a Compartment so we
    // can reconfigure them without remounting the EditorView when the
    // contributed set changes (e.g. function-registry HMR replacing a
    // CodeMirror extension's source).
    const compartment = contributedCompartmentRef.current!
    const contributedSlot = compartment.of(
      codeMirrorExtensionsRef.current as Extension[],
    )
    const extensions = isReadOnly
      ? [
          EditorView.editable.of(false),
          EditorState.readOnly.of(true),
          pillsFeature(),
          EditorView.lineWrapping,
          theme,
          contributedSlot,
        ]
      : [
          Prec.highest(composerKeymap),
          history(),
          drawSelection(),
          pillsFeature(),
          keymap.of([
            ...defaultKeymap.filter(b => b.key !== "Enter"),
            ...historyKeymap,
          ]),
          cmPlaceholder(placeholder),
          EditorView.lineWrapping,
          updateListener,
          theme,
          contributedSlot,
        ]
    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: seed,
        // Place caret at end of seeded doc so the user can keep typing.
        selection: { anchor: seed.length },
        extensions,
      }),
    })

    viewRef.current = view
    // Inject the db client so image pill widgets can hydrate blobs
    // from the zenbu blob store on cache miss (e.g. restored drafts).
    view.dispatch({
      effects: setDbClientEffect.of(dbClientFieldRef.current),
    })
    if (!isReadOnly) {
      view.focus()
      // Optionally select the whole seeded doc so the first
      // keystroke replaces it. Dispatched after focus so the
      // selection is visible (cm doesn't paint selections in
      // unfocused editors). Empty docs would produce an empty
      // selection — skip in that case.
      if (selectAllOnMountRef.current && seed.length > 0) {
        view.dispatch({
          selection: { anchor: 0, head: seed.length },
        })
      }
    }

    const onWindowFocus = () => {
      if (!isReadOnly) view.focus()
    }
    if (!isReadOnly) window.addEventListener("focus", onWindowFocus)

    return () => {
      if (!isReadOnly) {
        window.removeEventListener("focus", onWindowFocus)
        rememberComposerDraft(composerKeyRef.current, view.state.doc.toString())
      }
      view.destroy()
      viewRef.current = null
    }
  }, [placeholder, recomputeMenu])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    // Guard against <Activity> visibility toggles: this effect
    // re-mounts on every visible transition with the same
    // composerKey, which would otherwise clobber the preserved doc
    // with a stale `initialTextRef`. We only want to act when the
    // key actually changed from the last value we observed.
    const prevKey = lastComposerKeyRef.current
    lastComposerKeyRef.current = composerKey
    if (prevKey === composerKey) {
      console.log(
        `[composer] composerKey effect: skip (Activity remount or same key ${composerKey})`,
      )
      return
    }
    // composerKey changed (chat switch). Reset the editor to the new
    // chat's persisted draft. The EditorView itself is reused across
    // chat switches — only the doc is swapped — so we seed here
    // rather than depending on a fresh mount.
    const seed = seedForComposerKey(composerKey, initialTextRef.current ?? "")
    console.log(
      `[composer] composerKey effect: reseed ${prevKey ?? "<null>"}→${composerKey} seedLen=${seed.length}`,
    )
    // Skip the redundant first-mount run: the EditorView was already
    // constructed with `doc: seed`, so a same-string replace would
    // just fire the updateListener for no reason.
    if (view.state.doc.toString() === seed) {
      setMenu(null)
      setSelectedIndex(0)
      return
    }
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: seed },
      selection: { anchor: seed.length },
    })
    setMenu(null)
    setSelectedIndex(0)
  }, [composerKey])

  // Push the latest file index into the editor state whenever the
  // surrounding `files` prop changes. The decoration computer reads
  // from this field to validate `@<path>` tokens.
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const set = new Set<string>()
    for (const f of files) set.add(f.path)
    view.dispatch({ effects: setFileIndexEffect.of(set) })
  }, [files])

  // Plugin-contributed CodeMirror extensions live inside a
  // Compartment so we can reconfigure them without remounting the
  // EditorView. Whenever the contributed array changes — e.g. a
  // plugin's function-registry source file was edited and the
  // reconciler swapped in a new value — dispatch a reconfigure so
  // the live editor picks up the new set immediately.
  useEffect(() => {
    const view = viewRef.current
    const compartment = contributedCompartmentRef.current
    if (!view || !compartment) return
    view.dispatch({
      effects: compartment.reconfigure(mergedContributed as Extension[]),
    })
  }, [mergedContributed])

  // Subscribe to `appendComposerDraft` events: when a payload's
  // `composerId` matches ours, splice its text onto the end of the
  // current doc (with a separating newline if there's already
  // content). Targets the live EditorView directly so the caret
  // lands at the new end and a CodeMirror history entry is produced
  // (so the user can undo the append cleanly). No-op when we don't
  // have a `composerId` — callers that don't opt in stay inert.
  const events = useEvents()
  useEffect(() => {
    if (!composerId) return
    if (readOnly) return
    const off = events.app.appendComposerDraft.subscribe(payload => {
      if (payload.composerId !== composerId) return
      const view = viewRef.current
      if (!view) return
      const docLen = view.state.doc.length
      const existing = view.state.doc.toString()
      // Trim a trailing newline + prepend a blank line when there's
      // already content so the appended text starts on its own line
      // without doubling up blanks. Empty doc → just insert verbatim.
      const sep = docLen === 0 ? "" : existing.endsWith("\n") ? "\n" : "\n\n"
      const insert = `${sep}${payload.text}`
      view.dispatch({
        changes: { from: docLen, insert },
        selection: { anchor: docLen + insert.length },
        scrollIntoView: true,
      })
      view.focus()
    })
    return off
  }, [events, composerId, readOnly])

  // External "please focus me" signal. Fired by surfaces that swap
  // the active tab's chat in place (sidebar "New Chat", ⌘N) — the
  // EditorView is reused across switches, so mount-time auto-focus
  // never runs. Dispatched on `window` to keep the hop renderer-only.
  useEffect(() => {
    if (!composerId) return
    if (readOnly) return
    return subscribeFocusComposer(composerId, () => {
      viewRef.current?.focus()
    })
  }, [composerId, readOnly])

  // Chromeless wrappers: same minimal shell as `readOnly`, just the
  // composer pasted onto whatever background the parent supplies.
  // Keeping the two flags independent lets the user-message bubble
  // use `embedded` to mean "no chrome" for both its read-only and
  // editable states.
  const chromeless = readOnly || embedded
  return (
    <div
      className={
        chromeless
          ? "w-full"
          : "mx-auto w-full max-w-[919px] px-2 pt-1 pb-2"
      }
    >
      <div
        className={
          chromeless
            ? "relative overflow-visible"
            : "relative overflow-visible rounded-md border border-border bg-card/85 text-card-foreground"
        }
      >
        <div className="relative">
          <div ref={hostRef} className="composer-cm" />
          {menu?.kind === "file" && (
            <FilePickerMenu
              options={menu.options}
              selectedIndex={selectedIndex}
              onSelect={option => insertFile(option, menu.from, menu.to)}
              onHover={setSelectedIndex}
              anchor={menu.anchor}
            />
          )}
          {menu?.kind === "slash" && (
            <SlashCommandMenu
              options={menu.options}
              selectedIndex={selectedIndex}
              onSelect={option => handleSlash(option, menu.from, menu.to)}
              onHover={setSelectedIndex}
            />
          )}
        </div>

        {chromeless ? null : (
          <ComposerToolbar
            agentConfigs={agentConfigs}
            currentAgentConfigId={currentAgentConfigId}
            onChangeAgentConfig={onChangeAgentConfig}
            currentModel={currentModel}
            onChangeModel={onChangeModel}
            currentThinkingLevel={currentThinkingLevel}
            onChangeThinkingLevel={onChangeThinkingLevel}
            streaming={streaming}
            onInterrupt={onInterrupt}
            locked={locked}
            onUnlock={onUnlock}
            slot={toolbarSlot}
            onUpload={handleUploadClick}
          />
        )}
      </div>
    </div>
  )
}

