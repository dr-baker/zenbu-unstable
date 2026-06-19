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
  version: 87,
  operations: [
    {
      "op": "alter",
      "key": "settings",
      "changes": {
        "typeHash": {
          "from": "71145a5536a1129c",
          "to": "2721e1fe6b2da3de"
        },
        "default": {
          "from": {
            "theme": "system",
            "chatBackground": null,
            "vimMode": true,
            "defaultSendMode": "followUp",
            "chatDevtools": false,
            "disableTelemetry": false
          },
          "to": {
            "theme": "system",
            "chatBackground": null,
            "vimMode": true,
            "defaultSendMode": "followUp",
            "chatDevtools": false,
            "perfTrace": false,
            "disableTelemetry": false
          }
        }
      }
    }
  ],
  migrate(prev, { apply }) {
    const result = apply(prev)
    // customize transformation here
    return result
  },
}

export default migration
