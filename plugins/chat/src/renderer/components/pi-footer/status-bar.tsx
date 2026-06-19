import type { ReactNode } from "react"

export const PI_FOOTER_HEIGHT = 22

export type StatusBarProps = {
  left?: ReactNode
  right?: ReactNode
}

/**
 * The 22px chrome strip that sits at the bottom of every chat
 * pane. Pure layout — two slots (`left` anchored to the start,
 * `right` anchored to the end). `PiFooter` fills these from the
 * discovered footer items.
 *
 * Sibling to `WorkspaceRail` / `Sidebar`: host-owned chrome that
 * exposes a slot for plugins to drop content into.
 */
export function StatusBar({ left, right }: StatusBarProps) {
  return (
    <div
      className="flex shrink-0 items-stretch border-t text-muted-foreground text-[11px]"
      style={{
        height: PI_FOOTER_HEIGHT,
        WebkitAppRegion: "no-drag",
      } as React.CSSProperties}
    >
      <div className="flex items-stretch">{left}</div>
      <div className="ml-auto flex items-stretch">{right}</div>
    </div>
  )
}
