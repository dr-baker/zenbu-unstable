import { definePlugin } from "@zenbujs/core/config";

/**
 * pi-footer plugin.
 *
 * Contributes the canonical pi footer items into the host's
 * footer slot. The footer chrome (`PiFooter`, the 22px strip at
 * the bottom of every chat pane) is host-owned — same shape as
 * the workspace rail or the left sidebar: host renders the chrome,
 * plugins drop in items via a `meta.kind` convention.
 *
 * The two items this plugin registers:
 *
 *   - `pi-footer.scope-info` — branch + cwd + extra dirs for the
 *     active session's scope. `meta.position = "left"`, order 10.
 *   - `pi-footer.chat-stats` — context-window gauge, cost, and
 *     auto-compact toggle. `meta.position = "left"`, order 20.
 *
 * Both are registered as plain `rendering: "component"` views with
 * `meta.kind = "pi-footer.item"`. Anyone — first-party or
 * third-party — can contribute more footer items the same way, or
 * via `useRegisterFunction(name, Component, { kind: "pi-footer.item", … })`
 * from inside the React tree (the path `cm-vim` uses for its mode
 * indicator).
 *
 * Depends on `app` for typed access to the host's db
 * (`root.pi.sessions`, `root.app.scopes`, `root.app.repos`,
 * `root.app.env.homeDir`) and RPC (`rpc.pi.sessions.*`) used by
 * the two items.
 */
export default definePlugin({
  name: "piFooter",
  services: ["./src/main/services/*.ts"],
  dependsOn: [
    { name: "pi", from: "../pi/zenbu.plugin.ts" },{ name: "app", from: "../../zenbu.config.ts" }],
});
