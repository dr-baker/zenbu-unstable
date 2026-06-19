/**
 * Scan a doc string for `@`-references and classify them as file pills
 * or image pills. The result is the single source of truth for pill
 * rendering AND wire serialization — there is no side state field
 * tracking pills.
 *
 * A `@` only starts a reference at start-of-doc/start-of-line or after
 * whitespace, matching the typeahead trigger rule in `typeahead.ts`.
 * That way "user@host" doesn't accidentally pillify.
 *
 * Token shape:
 *   - Image: `@blob:<id>` where id is [A-Za-z0-9_-]+. (TODO(zenbu):
 *     becomes `@<absolutePath>` once zenbu exposes a public blob→path
 *     API; at that point images collapse into the file case.)
 *   - File:  `@<path>` where path is non-whitespace plus a small set
 *     of path chars. We then look the path up in the supplied file
 *     index and only emit a pill on a hit — that way arbitrary
 *     `@something` strings stay as plain text.
 */

export type FilePill = {
  kind: "file"
  from: number
  to: number
  filePath: string
  fileName: string
}

export type UploadPill = {
  kind: "upload"
  from: number
  to: number
  /** Absolute filesystem path of the uploaded file. URL-encoded in the
   * doc so the token has clean whitespace boundaries; the widget
   * decodes for display. */
  filePath: string
  /** Basename of the uploaded file, derived from `filePath`. Cheap to
   * recompute but stashed here so the widget doesn't reparse. */
  fileName: string
}

export type ImagePill = {
  kind: "image"
  from: number
  to: number
  /** TODO(zenbu): temporary — see file-level comment. */
  blobId: string
  /** The widget hydrates bytes via the image cache, which knows the
   * real mimeType from paste / event-payload. The scanner has no way
   * to recover it from the doc alone, so we leave it generic and let
   * the widget / serializer overlay the real value when known. */
  mimeType: string
  /** Optional `{key=val, ...}` metadata suffix in the doc. We parse it
   * loosely as a string of `key=value` entries — the model is the only
   * consumer that reads the values, so we don't over-validate here. */
  metadata?: Record<string, string>
}

export type Pill = FilePill | UploadPill | ImagePill

/**
 * `@` followed by:
 *   - `blob:<id>` (image), or
 *   - a run of path-ish chars (file).
 *
 * The `(?:^|(?<=\s))` lookbehind enforces start-of-string-or-whitespace
 * without consuming any leading char, which keeps offsets clean.
 */
/**
 * `@` followed by:
 *   - `blob:<id>` (image) — optionally followed by a `{...}` metadata
 *     block. The metadata is opaque key=value pairs read by the model.
 *   - or a run of path-ish chars (file).
 *
 * The blob form captures the metadata block as part of the pill range
 * so the live-preview/atomic behavior treats the whole token as one
 * unit. Plain `@blob:<id>` without metadata is also accepted — that's
 * what the composer inserts on paste. The metadata form is what the
 * serializer emits when shipping to the model.
 */
const PILL_RE =
  /(?:^|(?<=\s))@(?:blob:([A-Za-z0-9_-]+)(\{[^}]*\})?|upload:(\S+)|([A-Za-z0-9_./-]+))/g

export function scanPills(
  docText: string,
  fileIndex: ReadonlySet<string>,
): Pill[] {
  const out: Pill[] = []
  for (const m of docText.matchAll(PILL_RE)) {
    const atIdx = m.index ?? -1
    if (atIdx < 0) continue
    const blobId = m[1]
    const metadataRaw = m[2]
    const uploadPathRaw = m[3]
    const filePath = m[4]
    const from = atIdx
    const to = atIdx + m[0]!.length

    if (uploadPathRaw) {
      let decoded = uploadPathRaw
      try {
        decoded = decodeURIComponent(uploadPathRaw)
      } catch {
        // Malformed escape — keep the raw token rather than dropping
        // the pill. The widget will just render the encoded form.
      }
      const slash = Math.max(
        decoded.lastIndexOf("/"),
        decoded.lastIndexOf("\\"),
      )
      const fileName = slash >= 0 ? decoded.slice(slash + 1) : decoded
      out.push({
        kind: "upload",
        from,
        to,
        filePath: decoded,
        fileName,
      })
      continue
    }

    if (blobId) {
      if (blobId.length === 0) continue
      out.push({
        kind: "image",
        from,
        to,
        blobId,
        // Generic — overridden by image-cache lookup at render/serialize time.
        mimeType: "image/*",
        metadata: metadataRaw ? parseMetadata(metadataRaw) : undefined,
      })
      continue
    }

    if (!filePath) continue
    if (!fileIndex.has(filePath)) continue
    const slash = filePath.lastIndexOf("/")
    const fileName = slash >= 0 ? filePath.slice(slash + 1) : filePath
    out.push({
      kind: "file",
      from,
      to,
      filePath,
      fileName,
    })
  }
  return out
}

/** Parse `{key=val, key2=val2}` into a flat record. Whitespace around
 * separators is tolerated. Values are taken verbatim (no quoting). */
function parseMetadata(raw: string): Record<string, string> {
  const inner = raw.slice(1, -1)
  const out: Record<string, string> = {}
  for (const part of inner.split(",")) {
    const eq = part.indexOf("=")
    if (eq < 0) continue
    const k = part.slice(0, eq).trim()
    const v = part.slice(eq + 1).trim()
    if (k) out[k] = v
  }
  return out
}

/**
 * Format the wire-form blob marker the model receives. The blob id
 * stays as-is so the marker remains parseable; metadata is appended
 * in `{key=val, ...}` form. Keys with `undefined` values are dropped.
 */
export function formatBlobMarker(
  blobId: string,
  metadata: Record<string, string | number | undefined>,
): string {
  const entries = Object.entries(metadata).filter(
    ([, v]) => v !== undefined && v !== "",
  )
  if (entries.length === 0) return `@blob:${blobId}`
  const inner = entries.map(([k, v]) => `${k}=${v}`).join(", ")
  return `@blob:${blobId}{${inner}}`
}

/**
 * Whether the selection "touches" a pill range for live-preview purposes.
 *
 * Asymmetric on purpose:
 *   - Left edge (`from`): inclusive. Cursor at `from` sits on the `@`,
 *     which conceptually is the start of the pill — user is stepping
 *     into it.
 *   - Right edge (`to`):  exclusive. Cursor at `to` sits on whatever
 *     comes after the pill (usually the trailing space). It's past
 *     the pill, not on it, so the decoration must stay.
 *
 * Without the asymmetry, hitting Esc in vim normal mode right after
 * inserting a pill would land on `to` and visibly strip the chip,
 * which is what felt wrong.
 */
export function selectionTouchesPill(
  sel: { from: number; to: number },
  pill: Pick<Pill, "from" | "to">,
): boolean {
  return sel.from < pill.to && sel.to >= pill.from
}
