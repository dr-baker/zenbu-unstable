import type { ScrollMetrics } from "./message-list"

export type MinimapProps = {
  scrollMetrics: ScrollMetrics | null
  onScrollTo: (scrollTop: number) => void
}

export function Minimap(_props: MinimapProps) {
  return null
}
