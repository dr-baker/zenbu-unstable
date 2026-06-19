import path from "node:path";
import { fileURLToPath } from "node:url";
import { Service } from "@zenbujs/core/runtime";
import { RpcService } from "@zenbujs/core/services";

// TODO(cross-plugin-deps): zenbu's `deps:` accepts either a service
// class reference or a service key string. We use the string form
// here because there is no first-class way to declare a typed
// dependency on another plugin's service yet. When zenbu grows one
// (the natural extension of `dependsOn` from renderer-only types to
// main-process service classes), replace `"piRuntime"` with a typed
// Pi plugin service import and drop the local interface below.

// The Pi extension path must still be absolute — it's handed to
// Pi's SDK at session activation, which expects an OS path.
const here = path.dirname(fileURLToPath(import.meta.url));
const PLAN_EXTENSION_PATH = path.resolve(here, "../../extension/index.ts");

type PiRuntimeApi = {
  registerExtension(args: {
    id: string;
    path: string;
    label?: string | null;
    pluginName?: string | null;
    source?: "plugin" | "built-in" | "user" | "project";
  }): Promise<{ ok: true }>;
  unregisterExtension(args: { id: string }): Promise<{ ok: true }>;
};

/**
 * Plan plugin service.
 *
 * Responsible for stitching this plugin into the host:
 *
 *  1. Registers `src/extension/index.ts` with the Pi plugin's
 *     `PiRuntimeService`. The host's `SessionsService` asks that
 *     runtime seam for every `activate()` and forwards the paths to
 *     Pi's `DefaultResourceLoader.additionalExtensionPaths`, so the
 *     `plan` tool becomes available to the LLM.
 *
 *  2. Registers the `plan` view — a standalone vite-served React
 *     tree that renders the Markdown payload via Streamdown
 *     (mermaid diagrams handled natively by Streamdown).
 *
 *  3. Installs around-advice on the host's `ToolCall` chat-message
 *     component. The advice short-circuits when `toolName === "plan"`
 *     and renders an "Open Plan" card with an onClick that calls
 *     `openInActivePane` on this service.
 *
 *  4. Exposes `openInActivePane({ toolCallId, title, markdown })`
 *     as the RPC the advice card calls. The implementation emits
 *     the host's generic `openViewInActivePane` event, which the
 *     shell catches and routes to `openViewBySourceInRoot`. The
 *     host never learns about `"plan"` as a view type — it just
 *     forwards the strings.
 *
 * Hot reload semantics:
 *  - Each `setup()` block pairs registration with cleanup, so a
 *    plugin reload cleanly unregisters and re-registers all four.
 *  - The Pi extension registration is reflected in
 *    `root.pi.extensions` so Pi/plugin-owned UI can list installed
 *    extensions via `useDb`.
 *  - Already-running sessions ignore the registry change; the user
 *    has to start or switch sessions to pick up changes.
 */
export class PlanService extends Service.create({
  key: "plan",
  deps: {
    // String-keyed dep on the Pi plugin's runtime seam. See the TODO
    // above for why this isn't a class import.
    piRuntime: "piRuntime",
    rpc: RpcService,
  },
}) {
  evaluate() {
    // 1. Contribute the Pi extension through the Pi plugin seam.
    this.setup("register-pi-extension", () => {
      const piRuntime = this.ctx.piRuntime as PiRuntimeApi;
      void piRuntime.registerExtension({
        id: "plan",
        path: PLAN_EXTENSION_PATH,
        label: "Plan",
        pluginName: "plan",
        source: "plugin",
      });
      return () => {
        void piRuntime.unregisterExtension({ id: "plan" });
      };
    });

    // 2. Register the split-pane Markdown viewer as a component view
    // mounted directly into the host renderer's React tree. Streamdown
    // is loaded from this plugin's node_modules via Node module
    // resolution starting from `plan-app.tsx`'s location.
    this.setup("inject-view", () =>
      this.inject({
        name: "plan",
        modulePath: "./src/views/plan/plan-app.tsx",
        exportName: "PlanApp",
        // `kind: "embed"` keeps the view out of the command palette
        // (it requires args to be meaningful); other code reaches it
        // via the generic `openViewInActivePane` event.
        meta: { kind: "embed", label: "Plan" },
      }),
    );

    // 3. Replace host's `ToolCall` chat component for plan tool calls.
    // `moduleId` must be the full path the host renderer registers
    // under (i.e. relative to the host's vite root,
    // `packages/app/src/renderer/`). Short suffixes silently do not
    // match — the advice runtime now emits a `console.error`
    // pointing at the right value when it detects a mismatch.
    this.setup("advise-tool-call", () =>
      this.advise({
        moduleId: "components/chat/messages/tool-call.tsx",
        name: "ToolCall",
        type: "around",
        modulePath: "./src/content/plan-tool-advice.tsx",
        exportName: "PlanToolAdvice",
      }),
    );
  }

  /**
   * Called from the chat advice when the user clicks "Open Plan".
   * Fires the host's generic `openViewInActivePane` event. The host
   * shell catches it and opens the `plan` view in a pane next to
   * the active one, reusing the existing tab for the same plan
   * tool call if one is already open (via the `source` sentinel).
   */
  async openInActivePane(args: {
    toolCallId: string;
    title: string;
    markdown: string;
  }): Promise<{ ok: true }> {
    this.ctx.rpc.emit.app.openViewInActivePane({
      viewType: "plan",
      source: `plan-${args.toolCallId}`,
      args: {
        toolCallId: args.toolCallId,
        title: args.title,
        markdown: args.markdown,
      },
    });
    return { ok: true };
  }
}
