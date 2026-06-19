import { useEffect, useState } from "react"
import { useDbClient } from "@zenbujs/core/react"
import {
  getImageUrl,
  hydrateImage,
} from "../../composer/lib/image-cache"

/**
 * Inline thumbnail for an image attached to a user_prompt event.
 * Hydrates the renderer image cache from the zenbu blob store on
 * first mount, then renders an `<img>` once bytes are available.
 *
 * Lives inside `<ZenbuProvider>` (unlike the composer pill widget),
 * so it can pull the db client through `useDbClient` and fetch
 * blobs directly.
 */
export function UserMessageImage({
  blobId,
  mimeType,
}: {
  blobId: string
  mimeType: string
}) {
  const client = useDbClient()
  const [url, setUrl] = useState<string | null>(() => getImageUrl(blobId))

  useEffect(() => {
    if (url) return
    let cancelled = false
    void hydrateImage(blobId, mimeType, client).then(u => {
      if (!cancelled) setUrl(u)
    })
    return () => {
      cancelled = true
    }
  }, [blobId, mimeType, client, url])

  if (!url) {
    return (
      <div
        className="flex h-24 w-32 items-center justify-center rounded border border-border bg-muted/40 text-[11px] text-muted-foreground"
        aria-label={`image (${mimeType})`}
      >
        loading…
      </div>
    )
  }

  return (
    <img
      src={url}
      alt="attached image"
      className="max-h-[240px] max-w-[320px] rounded border border-border object-contain"
      draggable={false}
    />
  )
}
