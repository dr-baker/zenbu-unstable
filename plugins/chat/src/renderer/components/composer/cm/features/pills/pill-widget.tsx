import { createRoot, type Root } from "react-dom/client"
import { WidgetType } from "@codemirror/view"
import type { DbClient } from "@zenbujs/core/react"
import { FileReferencePill } from "../../../file-reference-pill"
import { ImageReferencePill } from "../../../image-reference-pill"
import { UploadReferencePill } from "../../../upload-reference-pill"

/**
 * The widget tree runs OUTSIDE `<ZenbuProvider>` — CodeMirror mounts a
 * fresh React root via `createRoot(host)`. Anything the widget needs
 * (cached image URLs, file metadata) must therefore be available
 * through module-level singletons (see `lib/image-cache.ts`) or
 * passed in via the widget constructor.
 */

export class FilePillWidget extends WidgetType {
  constructor(
    readonly filePath: string,
    readonly fileName: string,
  ) {
    super()
  }

  eq(other: FilePillWidget): boolean {
    return other.filePath === this.filePath && other.fileName === this.fileName
  }

  toDOM(): HTMLElement {
    const host = document.createElement("span")
    host.style.display = "inline-block"
    host.style.verticalAlign = "baseline"
    const root = createRoot(host)
    root.render(
      <FileReferencePill fileName={this.fileName} filePath={this.filePath} />,
    )
    ;(host as HTMLElement & { __root?: Root }).__root = root
    return host
  }

  destroy(dom: HTMLElement): void {
    const root = (dom as HTMLElement & { __root?: Root }).__root
    if (root) queueMicrotask(() => root.unmount())
  }

  ignoreEvent(): boolean {
    return false
  }
}

export class UploadPillWidget extends WidgetType {
  constructor(
    readonly filePath: string,
    readonly fileName: string,
  ) {
    super()
  }

  eq(other: UploadPillWidget): boolean {
    return (
      other.filePath === this.filePath && other.fileName === this.fileName
    )
  }

  toDOM(): HTMLElement {
    const host = document.createElement("span")
    host.style.display = "inline-block"
    host.style.verticalAlign = "baseline"
    const root = createRoot(host)
    root.render(
      <UploadReferencePill
        fileName={this.fileName}
        filePath={this.filePath}
      />,
    )
    ;(host as HTMLElement & { __root?: Root }).__root = root
    return host
  }

  destroy(dom: HTMLElement): void {
    const root = (dom as HTMLElement & { __root?: Root }).__root
    if (root) queueMicrotask(() => root.unmount())
  }

  ignoreEvent(): boolean {
    return false
  }
}

export class ImagePillWidget extends WidgetType {
  constructor(
    readonly blobId: string,
    readonly mimeType: string,
    /** Threaded in from `dbClientField` so the inner React tree (which
     * mounts outside `<ZenbuProvider>`) can hydrate bytes from the
     * zenbu blob store on cache miss — e.g. when a draft containing
     * an `@blob:<id>` token is restored after a reload. */
    readonly dbClient: DbClient | null,
  ) {
    super()
  }

  eq(other: ImagePillWidget): boolean {
    return (
      other.blobId === this.blobId &&
      other.mimeType === this.mimeType &&
      other.dbClient === this.dbClient
    )
  }

  toDOM(): HTMLElement {
    const host = document.createElement("span")
    host.style.display = "inline-block"
    host.style.verticalAlign = "middle"
    const root = createRoot(host)
    root.render(
      <ImageReferencePill
        blobId={this.blobId}
        mimeType={this.mimeType}
        dbClient={this.dbClient}
      />,
    )
    ;(host as HTMLElement & { __root?: Root }).__root = root
    return host
  }

  destroy(dom: HTMLElement): void {
    const root = (dom as HTMLElement & { __root?: Root }).__root
    if (root) queueMicrotask(() => root.unmount())
  }

  ignoreEvent(): boolean {
    return false
  }
}
