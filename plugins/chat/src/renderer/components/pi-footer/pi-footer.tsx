import { View } from "@zenbujs/core/react"
import { StatusBar } from "./status-bar"
import { useFooterItems, type FooterItem } from "@/lib/footer-items"

export type PiFooterProps = {
  /** The session driving any contextual items in the strip
   * (`pi-footer.scope-info`, `pi-footer.chat-stats`, …).
   * Threaded down from the owning `ChatPane` so each pane's
   * footer reflects *its* chat, not whichever pane is
   * window-active. Forwarded into every component-view item as
   * `args.sessionId`. */
  sessionId: string | null
}

/**
 * The footer strip at the bottom of every chat pane. Same family
 * as `WorkspaceRail` / `LeftSidebar`: host-owned chrome that
 * exposes a registry-based slot for plugins to drop items into.
 *
 * No item-specific code here — discovery + layout only. Items are
 * injected by plugins with `meta.kind = "footer.item"` and rendered
 * uniformly as `<View name={item.viewType} args={{ sessionId }} />`.
 * Items that don't need session context simply ignore the prop.
 */
export function PiFooter({ sessionId }: PiFooterProps) {
  const { left, right } = useFooterItems()

  return (
    <StatusBar
      left={left.map(item => (
        <FooterItemSlot key={item.key} item={item} sessionId={sessionId} />
      ))}
      right={right.map(item => (
        <FooterItemSlot key={item.key} item={item} sessionId={sessionId} />
      ))}
    />
  )
}

function FooterItemSlot({
  item,
  sessionId,
}: {
  item: FooterItem
  sessionId: string | null
}) {
  return (
    <View name={item.viewType} args={{ sessionId }} fallback={null} />
  )
}
