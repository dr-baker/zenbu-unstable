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
  version: 84,
  operations: [
    {
      "op": "alter",
      "key": "plugins",
      "changes": {
        "typeHash": {
          "from": "1bdd1b5849aa6bc0",
          "to": "7621a211474ec4c1"
        }
      }
    }
  ],
  migrate(prev, { apply }) {
    const result = apply(prev)
    const plugins = Array.isArray(result.plugins) ? result.plugins : []
    for (const plugin of plugins) {
      if (!Array.isArray(plugin.dependencies)) plugin.dependencies = []
      if (!("updatedAt" in plugin)) plugin.updatedAt = null
    }
    return result
  },
}

export default migration
