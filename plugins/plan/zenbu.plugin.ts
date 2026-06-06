import { definePlugin } from "@zenbujs/core/config";

/**
 * Plan plugin.
 *
 * Contributes:
 *  - a Pi extension (`src/extension/index.ts`) registering a `plan`
 *    tool the LLM can call with `{ title, markdown }`,
 *  - a renderer-side advice (`src/content/plan-tool-advice.tsx`)
 *    that intercepts the host's `ToolCall` component when
 *    `toolName === "plan"` and renders an "Open Plan" card,
 *  - a `plan` view (`src/views/plan/`) that renders the Markdown
 *    in a split pane (mermaid diagrams included via Streamdown).
 *
 * The plugin reaches into Zenbu through two generic primitives —
 * the Pi plugin's `PiRuntimeService.registerExtension(...)` seam and
 * the app plugin's `openViewInActivePane` event — so the app stays
 * free of any `plan`-specific Pi code.
 */
export default definePlugin({
  name: "plan",
  services: ["./src/main/services/*.ts"],
  dependsOn: [
    // Required for typed access to the host's RPC (`rpc.app.openViewInActivePane`
    // emit) and generated DB/events surface used by the renderer advice.
    { name: "app", from: "../../zenbu.config.ts" },
    // Required for the Pi runtime extension-registration seam.
    { name: "pi", from: "../pi/zenbu.plugin.ts" },
  ],
  icons: {
    // lucide: list-checks
    plan:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 5h8"/><path d="M13 12h8"/><path d="M13 19h8"/><path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/></svg>',
  },
});
