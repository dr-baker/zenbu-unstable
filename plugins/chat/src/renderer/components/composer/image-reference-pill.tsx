import { useEffect, useState } from "react"
import type { DbClient } from "@zenbujs/core/react"
import { getImageUrl, hydrateImage } from "./lib/image-cache"

export type ImageReferencePillProps = {
  blobId: string
  mimeType: string
  /** Provided by `ImagePillWidget` via the `dbClientField` in the
   * editor state. Lets us hydrate bytes from the zenbu blob store on
   * cache miss \u2014 the case that matters when a persisted draft
   * containing `@blob:<id>` is restored after a reload. May be null
   * briefly during mount before the composer dispatches the client. */
  dbClient: DbClient | null
}

/**
 * Inline image preview rendered over an `@blob:<id>` pill range in the
 * composer.
 *
 * Two paths into this widget:
 *   1. Live paste \u2014 the composer's paste handler already called
 *      `putImage` synchronously, so `getImageUrl(blobId)` hits on
 *      first render and we draw the image with no async work.
 *   2. Restored draft \u2014 the cache is cold, so we fall through to
 *      `hydrateImage`, which pulls bytes from the zenbu blob store
 *      and sniffs the mime (see image-cache.ts; temporary until
 *      zenbu.js issue #8 lands). Pill widget runs outside
 *      `<ZenbuProvider>`, so it receives the db client through the
 *      `ImagePillWidget` constructor instead of `useDbClient`.
 */
export function ImageReferencePill({
  blobId,
  mimeType,
  dbClient,
}: ImageReferencePillProps) {
  const [url, setUrl] = useState<string | null>(() => getImageUrl(blobId))

  useEffect(() => {
    if (url) return
    if (!dbClient) return
    let cancelled = false
    void hydrateImage(blobId, mimeType, dbClient).then(u => {
      if (!cancelled && u) setUrl(u)
    })
    return () => {
      cancelled = true
    }
  }, [blobId, mimeType, dbClient, url])

  if (!url) {
    return (
      <span
        className="inline-flex items-center gap-1 rounded border border-border bg-muted/40 px-1 py-px align-bottom text-[11px] text-muted-foreground"
        aria-label={`image (${mimeType})`}
      >
        <ImagePlaceholder /> loading…
      </span>
    )
  }

  return (
    <span
      className="inline-flex align-middle"
      aria-label={`image (${mimeType})`}
    >
      <img
        src={url}
        alt="pasted image"
        className="max-h-[96px] max-w-[200px] rounded border border-border object-contain"
        draggable={false}
      />
    </span>
  )
}

function ImagePlaceholder() {
  return (
    <svg
      className="size-3 shrink-0"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="9" cy="9" r="2" />
      <path d="M21 15l-5-5L5 21" />
    </svg>
  )
}
