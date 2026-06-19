import { definePlugin } from "@zenbujs/core/config";

/**
 * The host application plugin.
 *
 * Conceptually this *is* the app — services, schema, events,
 * migrations, and the sidebar/tab/etc. icon set all live here.
 * It's still loaded as a regular plugin from the root
 * `zenbu.config.ts`; defining it in its own file (matching the
 * `packages/plan` / `packages/open-files` structure) makes
 * `zen link` write the app's generated types under
 * `packages/app/.zenbu/types/`, which is what
 * `packages/app/tsconfig.json` includes. With the plugin defined
 * inline in the root config, `zen link` only emits types at the
 * repo root, leaving `packages/app/tsconfig.json` unable to
 * resolve `./.zenbu/types/zenbu-register.ts`.
 *
 * Icons below are verbatim copies of lucide v1.16.0 path data
 * (see `node_modules/lucide-react/dist/esm/icons/*.mjs`). Wrapped
 * in the lucide default SVG envelope so they render identically to
 * the lucide-react components used elsewhere in the app.
 */
const SVG_PREFIX =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">';
const SVG_SUFFIX = "</svg>";
const lucide = (body: string) => `${SVG_PREFIX}${body}${SVG_SUFFIX}`;

// lucide: file
const FILE =
  '<path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"/><path d="M14 2v5a1 1 0 0 0 1 1h5"/>';
// lucide: folder — used by the host-owned `file-tree` pane view.
const FOLDER =
  '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>';
// lucide: git-compare
const GIT_COMPARE =
  '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><path d="M11 18H8a2 2 0 0 1-2-2V9"/>';
// lucide: terminal — reused for `tool-output` (which shows bash output).
const TERMINAL = '<path d="M12 19h8"/><path d="m4 17 6-6-6-6"/>';
// lucide: git-pull-request
const GIT_PULL_REQUEST =
  '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><line x1="6" x2="6" y1="9" y2="21"/>';
// lucide: sparkles — the onboarding tutorial view icon.
const SPARKLES =
  '<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/><path d="M4 17v2"/><path d="M5 18H3"/>';

export default definePlugin({
  name: "app",
  services: ["./src/main/services/*.ts"],
  schema: "./src/main/schema/index.ts",
  events: "./src/main/events.ts",
  migrations: "./migrations",
  // Type-only dep so host renderer code (sidebar keyboard nav,
  // worktree-group helpers) can read `root.agentSidebar.*`. zenbu's
  // `dependsOn` is purely a `zen link` directive — it doesn't
  // create a runtime load order, so the agent-sidebar plugin can
  // still declare `dependsOn: app` without a cycle.
  dependsOn: [
    { name: "agentSidebar", from: "../agent-sidebar/zenbu.plugin.ts" },
    // Type-only: the tutorial view calls `rpc.openProjects.*`.
    { name: "openProjects", from: "../open-projects/zenbu.plugin.ts" },
    // Type-only: chat/composer surfaces read `root.pi.sessions` and
    // call `rpc.pi.sessions` / `rpc.pi.auth` — sessions and auth moved
    // to the pi plugin (Phase 2 of the app decomposition). The mutual
    // app↔pi dependsOn is fine: it's a `zen link` directive, not a
    // runtime load order.
    { name: "pi", from: "../pi/zenbu.plugin.ts" },
  ],
  // Icons for injections owned by THIS plugin. Other plugins ship
  // their own icons; there's no cross-plugin lookup.
  icons: {
    "file-tree": lucide(FOLDER),
    file: lucide(FILE),
    "git-diff": lucide(GIT_COMPARE),
    // The tool-output side view rendered when a user clicks a chat
    // tool-call preview (currently only BashCard). Terminal icon
    // matches the "this is command output" semantics.
    "tool-output": lucide(TERMINAL),
    // The legacy Git view (services/pr.ts) is registered under view
    // type `"git"`. The original `pr` icon name belonged to that
    // view back when it was misnamed; new PR work lives under
    // `"pull-requests"` below.
    git: lucide(GIT_PULL_REQUEST),
    "pull-requests": lucide(GIT_PULL_REQUEST),
    tutorial: lucide(SPARKLES),
  },
});
