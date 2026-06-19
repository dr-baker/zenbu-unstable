type MigrationOp =
  | { op: "add"; key: string; kind: "data"; hasDefault: boolean; default?: any }
  | { op: "add"; key: string; kind: "collection"; debugName?: string }
  | { op: "add"; key: string; kind: "blob"; debugName?: string }
  | { op: "remove"; key: string; kind: "collection" | "blob" | "data" }
  | { op: "alter"; key: string; changes: Record<string, any> };

type KyjuMigration = {
  version: number;
  operations?: MigrationOp[];
  migrate?: (prev: any, ctx: { apply: (data: any) => any }) => any;
};

const migration: KyjuMigration = {
  version: 83,
  operations: [
    {
      "op": "remove",
      "key": "sessionMeta",
      "kind": "data"
    },
    {
      "op": "alter",
      "key": "sessions",
      "changes": {
        "typeHash": {
          "from": "aa18db08fe4063bc",
          "to": "98bc0df661838c39"
        }
      }
    }
  ],
  migrate(prev, { apply }) {
    const sessionMeta = (prev.sessionMeta as Record<string, any> | undefined) ?? {}
    const result = apply(prev)
    const sessions = result.sessions as Record<string, any> | undefined
    if (sessions) {
      for (const [sessionId, session] of Object.entries(sessions)) {
        const meta = sessionMeta[sessionId]
        const sentAt = meta?.lastMessageSentTime
        const summary = meta?.summary?.text
        if (
          typeof summary === "string" &&
          summary.trim() &&
          (!session.title || session.title === "Untitled")
        ) {
          session.title = summary.trim()
        }
        session.lastMessageSentTime =
          typeof sentAt === "number" ? sentAt : session.lastMessageSentTime ?? null
      }
    }
    delete result.sessionMeta
    return result
  },
}

export default migration
