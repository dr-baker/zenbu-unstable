import type { DbClient } from "@zenbujs/core/react"

/**
 * Renderer-local cache mapping a blobId to an object URL plus the
 * underlying bytes. Single source of truth for image previews in
 * both the composer (CodeMirror pill widget) and the chat history
 * (UserMessage component).
 *
 * Populated synchronously on paste so the inline image widget can
 * render the new pill without any await. Lazily hydrated from the
 * zenbu blob store via `hydrateImage` for pills that came from a
 * serialized `user_prompt` event (chat scrollback / page reload).
 *
 * URLs are never revoked while the app is running — image refs may
 * reappear in the composer (edit-and-resend) or scrollback (scroll
 * up). Total bytes are bounded by what's been pasted/loaded this
 * session; if that ever becomes a problem we switch to LRU.
 */

type Entry = {
  url: string
  mimeType: string
  bytes: Uint8Array
}

const entries = new Map<string, Entry>()
const inflight = new Map<string, Promise<string | null>>()

/** Sync lookup — returns an object URL if we already have it, else null. */
export function getImageUrl(blobId: string): string | null {
  return entries.get(blobId)?.url ?? null
}

/** Sync lookup for raw bytes — used by the serializer to build ImageContent. */
export function getImageBytes(
  blobId: string,
): { bytes: Uint8Array; mimeType: string } | null {
  const e = entries.get(blobId)
  return e ? { bytes: e.bytes, mimeType: e.mimeType } : null
}

/**
 * Insert freshly-known bytes into the cache. Called from the paste
 * handler right after `createBlob` resolves, and from `hydrateImage`
 * after fetching bytes from the DB.
 */
export function putImage(
  blobId: string,
  bytes: Uint8Array,
  mimeType: string,
): string {
  const existing = entries.get(blobId)
  if (existing) return existing.url
  const blob = new Blob([bytes as BlobPart], { type: mimeType })
  const url = URL.createObjectURL(blob)
  entries.set(blobId, { url, mimeType, bytes })
  return url
}

/**
 * Fetch bytes from the zenbu blob store and cache them. Coalesces
 * concurrent calls for the same blobId. Returns the object URL, or
 * null if the blob no longer exists in the store.
 *
 * `mimeType` is optional: when omitted (e.g. restoring a draft where
 * the only thing we have is the `@blob:<id>` token), we sniff the
 * type from magic bytes via `sniffImageMime`.
 *
 * TODO(zenbu): temporary hack. The blob store has no content-type
 * metadata of its own, so callers either have to maintain a parallel
 * `{ blobId → mime }` map or sniff. Remove this once
 * https://github.com/zenbu-labs/zenbu.js/issues/8 lands and we can
 * just `await client.getBlobMetadata(blobId)`.
 */
export async function hydrateImage(
  blobId: string,
  mimeType: string | undefined,
  client: DbClient,
): Promise<string | null> {
  const have = entries.get(blobId)
  if (have) return have.url
  const pending = inflight.get(blobId)
  if (pending) return pending
  const p = (async () => {
    try {
      const data = await client.getBlobData(blobId)
      if (!data) return null
      const mime = mimeType ?? sniffImageMime(data)
      return putImage(blobId, data, mime)
    } finally {
      inflight.delete(blobId)
    }
  })()
  inflight.set(blobId, p)
  return p
}

/**
 * Best-effort mime detection from the first few bytes. Covers the
 * formats we actually paste (PNG, JPEG, GIF, WebP); anything else
 * falls back to `application/octet-stream`, which still renders fine
 * via `<img>` (browsers sniff) but will cause pi to reject the
 * payload on submit. That's acceptable for the unsupported cases.
 *
 * TODO(zenbu): delete when issue #8 (blob content-type metadata) is
 * shipped — at that point mime comes back from the storage layer
 * and we don't have to guess.
 */
export function sniffImageMime(bytes: Uint8Array): string {
  if (bytes.length >= 4) {
    // PNG: 89 50 4E 47
    if (
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47
    ) {
      return "image/png"
    }
    // JPEG: FF D8 FF
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
      return "image/jpeg"
    }
    // GIF: 47 49 46 38 ("GIF8")
    if (
      bytes[0] === 0x47 &&
      bytes[1] === 0x49 &&
      bytes[2] === 0x46 &&
      bytes[3] === 0x38
    ) {
      return "image/gif"
    }
  }
  // WebP: "RIFF" .... "WEBP"
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp"
  }
  return "application/octet-stream"
}
