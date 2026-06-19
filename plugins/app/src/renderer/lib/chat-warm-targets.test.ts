import { describe, expect, it } from "vitest"
import { chatWarmTargetsForPane } from "./chat-warm-targets"
import type { Schema } from "../../main/schema"
import type { PaneView } from "./window-state/types"

type Chat = Schema["chats"][string]
type Scope = Schema["scopes"][string]

function readyChat(id: string, scopeId: string, createdAt: number): Chat {
  return { id, scopeId, createdAt, session: { kind: "ready", sessionId: `session-${id}` } }
}

function scope(id: string, workspaceId: string): Scope {
  return {
    id,
    workspaceId,
    directory: `/tmp/${id}`,
    repoId: null,
    extraDirectories: [],
    createdAt: 1,
    archived: false,
    archivedAt: null,
    pinnedAt: null,
    unpinnedAt: null,
    pluginName: null,
  }
}

describe("chatWarmTargetsForPane", () => {
  it("prioritizes open hidden tabs before other project chats", () => {
    const pane: PaneView = {
      id: "pane-a",
      activeTabId: "tab-active",
      tabs: [
        { id: "tab-active", content: { kind: "chat", chatId: "active" } },
        { id: "tab-b", content: { kind: "chat", chatId: "open-b" } },
        { id: "tab-c", content: { kind: "chat", chatId: "open-c" } },
      ],
    }
    const chatsById = {
      active: readyChat("active", "scope-a", 10),
      "open-b": readyChat("open-b", "scope-a", 8),
      "open-c": readyChat("open-c", "scope-b", 9),
      newer: readyChat("newer", "scope-a", 20),
      sibling: readyChat("sibling", "scope-b", 30),
    }

    const targets = chatWarmTargetsForPane({
      pane,
      activeTabId: "tab-active",
      scopeId: "scope-a",
      chatsById,
      scopesById: {
        "scope-a": scope("scope-a", "workspace-a"),
        "scope-b": scope("scope-b", "workspace-a"),
      },
    })

    expect(targets.map(t => [t.chatId, t.reason])).toEqual([
      ["open-b", "open-tab"],
      ["open-c", "open-tab"],
      ["newer", "scope-chat"],
      ["sibling", "workspace-chat"],
    ])
  })

  it("skips pending, active, and out-of-workspace chats and respects the cap", () => {
    const pane: PaneView = {
      id: "pane-a",
      activeTabId: "tab-active",
      tabs: [
        { id: "tab-active", content: { kind: "chat", chatId: "active" } },
        { id: "tab-pending", content: { kind: "chat", chatId: "pending" } },
      ],
    }
    const chatsById: Record<string, Chat> = {
      active: readyChat("active", "scope-a", 10),
      pending: { id: "pending", scopeId: "scope-a", createdAt: 11, session: { kind: "pending" } },
      one: readyChat("one", "scope-a", 30),
      two: readyChat("two", "scope-a", 20),
      other: readyChat("other", "scope-other", 100),
    }

    const targets = chatWarmTargetsForPane({
      pane,
      activeTabId: "tab-active",
      scopeId: "scope-a",
      chatsById,
      scopesById: {
        "scope-a": scope("scope-a", "workspace-a"),
        "scope-other": scope("scope-other", "workspace-other"),
      },
      maxTargets: 1,
    })

    expect(targets.map(t => t.chatId)).toEqual(["one"])
  })
})
