import { View } from "@zenbujs/core/react"
import { TitleBar } from "../layout/title-bar"
import { TitleBarWorkspace } from "../layout/title-bar-workspace"
import { SidebarToggle } from "../title-bar/sidebar-toggle"
import { RightSidebarToggle } from "../title-bar/right-sidebar-toggle"
import { useActiveView, useActiveWorkspaceId } from "@/lib/window-state/active-view"
import { useLeftSidebarOpen, useSetLeftSidebarOpen } from "@/lib/window-state/workspace-ui"
import { useRightSidebarToggle } from "../../hooks/use-right-sidebar-toggle"
import {
  useTitleBarViews,
  type TitleBarViewArgs,
} from "@/lib/title-bar-views"
import {
  useActiveScope,
  useActiveWorkspace,
  useGlobalViewLabel,
} from "../../hooks/use-sidebar-selectors"

/** Renders one of three title-bar variants depending on what's
 * showing in the workspace area. Subscribes only to identity bits
 * — chat updates don't recommit.
 *
 * The right-slot action buttons (`OpenIn`, `Play`) are no longer
 * baked into this file; they're plugin-contributed component
 * views surfaced through `useTitleBarViews()`. Each contribution
 * gets the same `args` shape (workspace, scope, directory) and
 * decides on its own whether to render. The sidebar toggles stay
 * host-owned because they're orthogonal to
 * the plugin surface. The commit button is no longer host-owned
 * either — it ships as the `commit-button` plugin and arrives
 * through the same `title-bar` injection slot as the others. */
export function WorkspaceTitleBar() {
  const activeView = useActiveView()
  const activeWorkspace = useActiveWorkspace()
  const activeScope = useActiveScope()
  const activeWorkspaceId = useActiveWorkspaceId()
  const sidebarOpen = useLeftSidebarOpen()
  const setSidebarOpen = useSetLeftSidebarOpen()
  const { isRightBodyOpen, onRightToggle, sidebarViews } =
    useRightSidebarToggle()

  if (activeView.kind === "onboarding") {
    return <TitleBar label="New workspace" />
  }

  if (activeView.kind === "view") {
    return <WorkspaceTitleBarGlobalView />
  }

  const args: TitleBarViewArgs = {
    workspaceId: activeWorkspaceId,
    scopeId: activeScope?.id ?? null,
    directory: activeScope?.directory ?? null,
  }

  return (
    <TitleBar
      left={
        <SidebarToggle
          open={sidebarOpen}
          onToggle={() => setSidebarOpen(o => !o)}
        />
      }
      center={
        activeWorkspace ? (
          <TitleBarWorkspace
            name={activeWorkspace.name}
            icon={activeWorkspace.icon ?? null}
            iconAuto={activeWorkspace.iconAuto ?? null}
          />
        ) : null
      }
      right={
        <>
          <TitleBarPluginSlots args={args} />
          {sidebarViews.length > 0 && (
            <RightSidebarToggle
              open={isRightBodyOpen}
              onToggle={onRightToggle}
            />
          )}
        </>
      }
    />
  )
}

/** Workspace-less full-area view (e.g. Settings opened from the
 * onboarding screen). Label comes from the view registry, same
 * source the command palette uses. */
function WorkspaceTitleBarGlobalView() {
  const label = useGlobalViewLabel()
  return <TitleBar label={label} />
}

/** Mounts every plugin-contributed title-bar view in ascending
 * `meta.order`. Each view receives the same `args` and
 * is responsible for deciding whether to render.
 *
 * Implemented as its own component so the parent only re-renders
 * when `args` identity changes, not when an unrelated registry
 * write lands. */
function TitleBarPluginSlots({ args }: { args: TitleBarViewArgs }) {
  const views = useTitleBarViews()
  if (views.length === 0) return null
  return (
    <>
      {views.map(v => (
        <View key={v.type} name={v.type} args={args} />
      ))}
    </>
  )
}
