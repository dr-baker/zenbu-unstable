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
  version: 78,
  operations: [
    {
      "op": "alter",
      "key": "plugins",
      "changes": {
        "typeHash": {
          "from": "4ebb7dff5236ab03",
          "to": "24fee170c5e4a25b"
        }
      }
    },
    {
      "op": "alter",
      "key": "settings",
      "changes": {
        "default": {
          "from": {
            "theme": "system",
            "chatBackground": null,
            "vimMode": true,
            "defaultSendMode": "followUp",
            "chatDevtools": false
          },
          "to": {
            "theme": "system",
            "chatBackground": null,
            "vimMode": true,
            "defaultSendMode": "followUp",
            "chatDevtools": false,
            "disableTelemetry": false
          }
        }
      }
    }
  ],
}

export default migration
