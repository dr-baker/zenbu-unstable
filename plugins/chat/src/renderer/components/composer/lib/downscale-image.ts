/**
 * Downscale an image for transmission to a vision model.
 *
 * Anthropic's official guidance
 * (https://docs.anthropic.com/en/docs/build-with-claude/vision):
 *   - Max 5MB per image (API), 20 images per request.
 *   - Resize so the longest edge is ≤ 1568px. Anything larger gets
 *     auto-scaled server-side anyway and burns extra tokens.
 *   - Image tokens ≈ (width × height) / 750; staying under ~1.15 MP
 *     gives the best latency/cost without losing fidelity.
 *
 * We run this in the renderer (Chromium), so we use built-in browser
 * APIs — `createImageBitmap` + `OffscreenCanvas` + `convertToBlob` —
 * with no external dependency. Node has no built-in raster image
 * codec, but the renderer does, so we get this for free.
 *
 * Strategy:
 *   1. Decode the bytes with `createImageBitmap` (supports PNG/JPEG/
 *      GIF/WebP, i.e. the same set Anthropic accepts).
 *   2. If the longest edge is already ≤ 1568 *and* the file is under
 *      ~1MB, pass through verbatim — no point re-encoding and losing
 *      quality for an already-small image.
 *   3. Otherwise rescale to fit 1568px on the long edge, paint onto
 *      an `OffscreenCanvas`, and re-encode as JPEG at q=0.9. JPEG is
 *      the smallest option that all model providers accept; alpha is
 *      flattened against white (vision models don't care about
 *      transparency).
 *
 * The function is best-effort: if anything throws (corrupt bytes,
 * unsupported codec, OOM on a huge image), we log and return the
 * original bytes unchanged so the user's send still goes through.
 */

const MAX_EDGE_PX = 1568
// Below this, skip re-encode: the image already fits the budget and
// re-encoding would only add JPEG artifacts.
const PASSTHROUGH_BYTES = 1024 * 1024 // 1 MB
const JPEG_QUALITY = 0.9

export type DownscaledImage = {
  bytes: Uint8Array
  mimeType: string
}

export async function downscaleImage(
  bytes: Uint8Array,
  mimeType: string,
): Promise<DownscaledImage> {
  // Quick passthrough: small enough that resizing only hurts.
  if (bytes.byteLength <= PASSTHROUGH_BYTES) {
    const dims = await tryReadDimensions(bytes, mimeType)
    if (dims && Math.max(dims.width, dims.height) <= MAX_EDGE_PX) {
      return { bytes, mimeType }
    }
  }

  try {
    const blob = new Blob([bytes as BlobPart], { type: mimeType })
    const bitmap = await createImageBitmap(blob)
    const { width: srcW, height: srcH } = bitmap
    const longest = Math.max(srcW, srcH)
    const scale = longest > MAX_EDGE_PX ? MAX_EDGE_PX / longest : 1
    const dstW = Math.max(1, Math.round(srcW * scale))
    const dstH = Math.max(1, Math.round(srcH * scale))

    const canvas = new OffscreenCanvas(dstW, dstH)
    const ctx = canvas.getContext("2d", { alpha: false })
    if (!ctx) {
      bitmap.close()
      return { bytes, mimeType }
    }
    // Flatten alpha onto white so JPEG doesn't render transparency as
    // black. Vision models don't care about background colour either
    // way; white reads cleanest for screenshots of light-themed UIs.
    ctx.fillStyle = "#ffffff"
    ctx.fillRect(0, 0, dstW, dstH)
    ctx.drawImage(bitmap, 0, 0, dstW, dstH)
    bitmap.close()

    const outBlob = await canvas.convertToBlob({
      type: "image/jpeg",
      quality: JPEG_QUALITY,
    })
    const outBytes = new Uint8Array(await outBlob.arrayBuffer())

    // Defensive: if our "downscaled" output is somehow larger than
    // the input (tiny images can round-trip bigger as JPEG), keep
    // the original.
    if (outBytes.byteLength >= bytes.byteLength && scale === 1) {
      return { bytes, mimeType }
    }
    return { bytes: outBytes, mimeType: "image/jpeg" }
  } catch (err) {
    console.warn("[downscale] failed, sending original bytes:", err)
    return { bytes, mimeType }
  }
}

/**
 * Cheap dimensions probe that avoids a full decode for the
 * passthrough fast path. Falls back to `createImageBitmap` if the
 * format doesn't match the magic-byte sniffs we know about.
 */
async function tryReadDimensions(
  bytes: Uint8Array,
  mimeType: string,
): Promise<{ width: number; height: number } | null> {
  try {
    const blob = new Blob([bytes as BlobPart], { type: mimeType })
    const bitmap = await createImageBitmap(blob)
    const dims = { width: bitmap.width, height: bitmap.height }
    bitmap.close()
    return dims
  } catch {
    return null
  }
}
