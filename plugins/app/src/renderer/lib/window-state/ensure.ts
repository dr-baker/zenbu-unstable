import type {
  Root,
  ScopeUiStateRecord,
  WindowState,
  WorkspaceUiStateRecord,
} from "./types"
import { activeWorkspaceIdOf } from "./derived"

export function ensureWindowState(root: Root, windowId: string): WindowState {
  const existing = root.app.windowStates[windowId]
  if (existing) {
    if (!existing.scopeLastTerminal) existing.scopeLastTerminal = {}
    if (!existing.scopePanes) existing.scopePanes = {}
    if (!existing.workspaceActiveScope) existing.workspaceActiveScope = {}
    if (!existing.workspaceUiStates) existing.workspaceUiStates = {}
    if (!existing.scopeUiStates) existing.scopeUiStates = {}
    return existing
  }
  root.app.windowStates[windowId] = {
    selectedScopeId: null,
    scopeLastTerminal: {},
    activeView: { kind: "onboarding" },
    scopePanes: {},
    workspaceActiveScope: {},
    workspaceRailOpen: true,
    workspaceUiStates: {},
    scopeUiStates: {},
    pluginsView: { selectedPluginName: null, sidebarOpen: true },
    fullscreen: false,
  }
  return root.app.windowStates[windowId]!
}

export function ensureActiveWorkspaceUiState(
  ws: WindowState,
): WorkspaceUiStateRecord | null {
  const workspaceId = activeWorkspaceIdOf(ws)
  if (!workspaceId) return null
  let entry = ws.workspaceUiStates[workspaceId]
  if (!entry) {
    entry = {
      sidebarWidth: null,
      leftSidebarOpen: true,
      leftSidebarTab: "agent",
    }
    ws.workspaceUiStates[workspaceId] = entry
  }
  return entry
}

export function readActiveWorkspaceUiState(
  ws: WindowState | undefined,
): WorkspaceUiStateRecord | null {
  if (!ws) return null
  const workspaceId = activeWorkspaceIdOf(ws)
  if (!workspaceId) return null
  return ws.workspaceUiStates?.[workspaceId] ?? null
}

export function ensureActiveScopeUiState(
  ws: WindowState,
): ScopeUiStateRecord | null {
  const scopeId = ws.selectedScopeId
  if (!scopeId) return null
  let entry = ws.scopeUiStates[scopeId]
  if (!entry) {
    entry = {
      rightSidebarWidth: null,
      terminalHeight: null,
      bottomPanelOpen: false,
      bottomPanelView: null,
      rightSidebarOpenType: null,
      rightSidebarLastType: null,
    }
    ws.scopeUiStates[scopeId] = entry
  }
  return entry
}

export function readActiveScopeUiState(
  ws: WindowState | undefined,
): ScopeUiStateRecord | null {
  if (!ws) return null
  const scopeId = ws.selectedScopeId
  if (!scopeId) return null
  return ws.scopeUiStates?.[scopeId] ?? null
}
