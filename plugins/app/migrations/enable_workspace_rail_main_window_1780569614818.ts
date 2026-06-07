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
  version: 81,
  operations: [
    {
      "op": "alter",
      "key": "workspaces",
      "changes": {
        "typeHash": {
          "from": "f7089c97ed9f7294",
          "to": "d2ea7ae579fed4ec"
        }
      }
    }
  ],
  migrate(prev, { apply }) {
    const result = apply(prev)
    // Force the workspace rail on for the main window. The main
    // window is the one keyed `"main"` in `windowStates` (see
    // `window-id.ts`'s DEFAULT_WINDOW_ID); auxiliary windows
    // (plugin/chat windows) get their own ids and are left alone.
    const windowStates = result.windowStates as
      | Record<string, any>
      | undefined
    const main = windowStates?.["main"]
    if (main) {
      main.workspaceRailOpen = true
    }
    return result
  },
}

export default migration
