# Breaking changes

## 2026-06-12 — chat surface extracted to the `chat` plugin (Phase 3)

The chat pane, message list, composer (CodeMirror stack), chat footer
strip, and the standalone chat-window view moved from `plugins/app` to
`plugins/chat`. **No RPC, DB, or event renames** — `root.app.chats` /
`chatStates` / `chatWindows` deliberately stay in the app plugin (they
are shell-level conversation/tab handles also written by workspaces,
the sidebar, and pi's branching flows).

What did change:

- The app shell now mounts the pane through the `"chat-pane"`
  injection (registered by the chat plugin's `ChatSurfaceService`);
  the `"chat-window"` view injection is registered there too.
- `@zenbu/app/image-cache` → `@zenbu/chat/image-cache` (package
  export moved with the composer lib).
- **Advice module ids for the chat surface changed.** Module ids are
  vite-root-relative only for files under the host renderer root
  (`plugins/app/src/renderer`); files served from other plugins
  register under their ABSOLUTE path, and the advice registry is
  exact-key (short ids are reported at runtime, never applied). So
  `moduleId: "components/composer/composer.tsx"` no longer matches —
  advisers must resolve the absolute id against the chat plugin's
  directory:

  ```ts
  import { getPlugin } from "@zenbujs/core/runtime"
  const chatDir = getPlugin("chat")?.dir
  const moduleId = chatDir
    ? path.join(chatDir, "src/renderer/components/composer/composer.tsx")
    : "components/composer/composer.tsx"
  ```

  All five affected advisers (pi-commands, plan, skill-pills,
  code-rendering, research-tool-row) were migrated this way. This
  wart disappears once @zenbujs/core ships stable advice target ids
  (`advise({ target })`).

Running log of breaking moves from the app-plugin decomposition
(`plans/2026-06-11-app-plugin-decomposition.md`). All first-party
consumers migrate in lockstep within the same commit; this file exists
for out-of-tree plugin authors and for future archaeology.

## 2026-06-12 — sessions + auth moved from `app` to `pi` (Phase 2)

The pi plugin now owns live `AgentSession` lifecycle, session records,
queue, branching, the event log, Pi auth, and the model catalog.

Renames (old → new):

| Surface | Old | New |
| --- | --- | --- |
| RPC | `rpc.app.sessions.*` | `rpc.pi.sessions.*` |
| RPC | `rpc.app.auth.*` | `rpc.pi.auth.*` |
| RPC | `rpc.app.sessionActivity.*` | `rpc.pi.sessionActivity.*` |
| DB | `root.app.sessions` | `root.pi.sessions` |
| DB | `root.app.killedSessions` | `root.pi.killedSessions` |
| DB | `root.app.pendingReloadToasts` | `root.pi.pendingReloadToasts` |
| DB | `root.app.models` | `root.pi.models` |
| DB | `root.app.providerStatuses` | `root.pi.providerStatuses` |
| DB | `root.app.oauthFlow` | `root.pi.oauthFlow` |
| Events | `events.app.agentCompletedUnviewed` | `events.pi.agentCompletedUnviewed` |

Unchanged:

- Main-process service KEYS are global and did not change:
  `"sessions"`, `"auth"`, `"sessionActivity"` still resolve via
  string-key `deps`. Only the renderer-facing RPC namespace moved.
- Chat tab/draft state stays in app: `root.app.chats`,
  `root.app.chatStates`, `root.app.chatWindows`.
- Workspace/scope/repo model stays in app: `root.app.scopes`, etc.

Data migration: the app schema keeps the old keys dormant for one
release; the pi plugin backfills `root.app.sessions` (+ killed markers,
reload toasts) into `root.pi.*` on first evaluate. **Installs upgrading
across multiple releases must boot this release once before the release
that drops the app-side keys, or pre-move chat history will not be
carried over.** (Pi's own session files under `~/.zenbu/pi-sessions`
are unaffected either way.)
