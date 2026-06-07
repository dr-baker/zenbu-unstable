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
  version: 80,
  operations: [
    {
      "op": "alter",
      "key": "plugins",
      "changes": {
        "typeHash": {
          "from": "1914a5151f0cebf6",
          "to": "1bdd1b5849aa6bc0"
        }
      }
    }
  ],
}

export default migration
