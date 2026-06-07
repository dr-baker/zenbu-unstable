import { Service } from "@zenbujs/core/runtime"

const NAME = "commit-button"

/**
 * Commit-button service.
 *
 * The plugin owns no data — git status, the commit preview and the
 * commit mutation all live in the host's `git` service, and the PR
 * view is opened through the host's `github` service. So the only
 * thing this main-process service does is register the title-bar
 * component view; everything interesting happens in the renderer
 * (`commit-button-view.tsx`), where `directory` and the RPC handles
 * are already in scope.
 */
export class CommitButtonService extends Service.create({
  key: "commitButton",
}) {
  evaluate() {
    this.setup("inject-view", () =>
      this.inject({
        name: NAME,
        modulePath: "./src/views/commit-button-view.tsx",
        meta: {
          // Sits to the right of the other title-bar contributions
          // (`open-in` = 1, `play` = 2) but before the auto-updater
          // (10), matching where the host previously rendered it —
          // after the plugin slots, before the right-sidebar toggle.
          kind: "title-bar",
          order: 5,
          label: "Commit",
        },
      }),
    )
  }
}
