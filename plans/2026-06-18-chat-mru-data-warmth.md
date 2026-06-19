# Chat MRU Data Warmth

## Goal
Improve tab-switch responsiveness in Zenbu chat by separating "warm data" from "mounted full UI". Current state: the earlier warming reintegration made things responsive again by avoiding Pi activation on tab open, using lazy live sessions, keeping a bounded viewed-session pool, ending hidden `chat.open` traces, and reducing DB write floods from slash commands/resource catalogs. Remaining issue: switching between already-open chat tabs can still hitch. The likely cause is renderer-side work on reveal: event-log hydration/materialization, full ChatDisplay/Composer work, slash command derivation, and eager file-index mapping. Backend Pi warming helps send latency, but visual tab switching is mostly renderer data + React work.

Relevant repo/worktree context:
- Main repo: `/Users/daniel/.zenbu/apps/zenbu`.
- Feature worktree: `/Users/daniel/.zenbu/apps/zenbu/agent_features/.worktrees/chat-mru-data-warmth`.
- Important current app commits immediately before this feature include `c64ff4c end chat open traces when tabs hide`, `480a681 skip unchanged slash command registrations`, `2fd8593 reuse fresh pi resource catalogs on activation`, and current HEAD `4f34977 trace chat tab switch renderer work`.
- There is also an external local plugin repo `/Users/daniel/.zenbu/plugins/pi-auto-commands` with commit `6d13372 avoid rewriting runtime slash commands on tab switch`; this feature should ideally not require editing that external plugin.
- Key files to inspect first:
  - `plugins/app/src/renderer/components/layout/chat-pane-container.tsx`: tab strip, visited tabs, `<Activity>`, optimistic tab selection, hidden-tab trace termination.
  - `plugins/app/src/renderer/components/layout/chat-pane-slot.tsx`: injection seam for chat pane.
  - `plugins/chat/src/renderer/components/chat/chat-pane.tsx`: `useCollection(eventLogRef)`, `materializeMessages`, file-index mapping, slash command derivation, Composer props, ChatDisplay props.
  - `plugins/chat/src/renderer/components/chat/lib/materialize.ts`: event-log to display-message materialization.
  - `plugins/chat/src/renderer/components/chat/chat-display.tsx` and child message components: render cost for large message lists.
  - `plugins/chat/src/renderer/components/composer/*`: composer file/slash command expectations and whether file entries can become lazy/provider-based.
  - `plugins/pi/src/main/services/sessions.ts`, `plugins/pi/src/main/services/sessions/session-pool.ts`, `plugins/pi/src/main/services/session-activity.ts`: existing backend live-session pool and viewed-session prefetch behavior; do not regress lazy activation.
  - `plugins/app/src/main/services/slash-commands.ts` and `plugins/pi/src/main/services/pi-resource-registry.ts`: recent anti-flood fixes; preserve their behavior.
- Current known measurements before this feature:
  - Good idle DB trace should be repo polling only, about 4 events over several seconds.
  - Good traced tab open spans after recent fixes were around `chat.open` 95-130ms and `chat.session.subscribe` 100-180ms.
  - Normal Playwright locator actionability can over-wait on flexing tab-strip elements; use perf spans and DB trace as well as wall-clock.
- Validation preference:
  - Run `pnpm run typecheck`.
  - Run targeted Vitest where touched files have tests, plus any new tests you add.
  - Relaunch dev client with a CDP port, e.g. `ZENBU_CDP_PORT=9225 pnpm dev --verbose`, and use Playwright to validate tab switching/new chat/send if feasible.
  - Because this runs in a feature worktree, Playwright/dev launch may hit profile/config/external-plugin issues. If so, make a best effort, document the blocker, and skip Playwright rather than derailing the implementation.
  - Do not paste full renderer `href`s or websocket-token URLs in notes/output.
- Commit discipline: produce exactly one commit per TODO item below, four commits total for this feature if all todos complete. Each commit should be independently buildable and should update this plan's progress notes as appropriate.

## TODO
- [x] Commit 1 — Add bounded MRU chat data cache for materialized messages. Inspect current `materializeMessages(events, ...)` usage and introduce a small, renderer-side cache keyed by stable session/event-log identity plus materialization inputs such as directory, extraDirectories, workspaceId, scopeId, and last event seq. The cache should keep only a bounded MRU set of recent chats/tabs, reuse the previous materialized result when events/input identity have not changed, and ideally update incrementally or at least avoid rematerializing unchanged histories on every reveal. Add focused unit tests for cache hit/miss/eviction behavior if the cache can be isolated. Preserve correctness for branch navigation/event-log rebuilds by invalidating when collection identity or event sequence/history shape changes.
- [x] Commit 2 — Replace full hidden-tab warmth with data-only warmth for recent tabs. Adjust `ChatPaneContainer`/`ChatPane` architecture so inactive visited chat tabs do not keep doing full ChatPane/Composer/ChatDisplay work indefinitely, but their chat data can remain warm through the MRU cache from Commit 1. Active tab should render the full live pane. Hidden tabs may render a cheap dormant shell, cached preview, or no heavy subtree, as long as drafts/scroll/chat correctness are preserved. Keep behavior bounded: active tab plus a small MRU set may be data-warm, but avoid full UI trees/subscriptions for every visited tab. Do not reintroduce Pi activation on tab open.
- [x] Commit 3 — Make tab reveal render from cached materialized data immediately, then hydrate/live-update. On tab switch, the user should see the cached message model quickly while event-log subscription/live data catches up. Preserve scroll position per chat/tab where practical, keep composer draft persistence working for real chats and pending chats, and ensure `chat.open` trace terminal markers still reflect first visible frame/composer readiness. If a cache is stale or missing, fall back safely to existing materialization behavior. This commit should focus on perceived switching latency and correctness on branch/navigation/session updates.
- [x] Commit 4 — Lazy-load file entries for composer context instead of eagerly mapping every file path for every chat pane. Current `ChatPane` maps the per-scope file path collection into `FileEntry[]` and passes it to `Composer`, which can be expensive and unnecessary unless the user opens context/file completion. Refactor toward a lazy provider/search interface or deferred derivation so normal tab switching does not rebuild thousands of file entries. Preserve existing `@`/context UX, file search behavior, and plugin advice expectations. Add tests where possible around provider behavior or fallback compatibility.

## Progress Notes
- 2026-06-18: User requested feature-flow background implementation despite dirty worktree. Goal is four broad implementation commits, one per idea: MRU materialized-message cache, data-only hidden-tab warmth, cached immediate reveal/hydrate, lazy file entries. The feature should protect recent anti-flood/lazy-activation behavior and use Playwright validation when possible.
- Architecture notes for implementer: Think of this as separating three layers: backend Pi liveness, renderer chat data/materialized messages, and full React UI. Backend liveness should stay lazy/bounded. Renderer data can be warm for an MRU set. Full hidden React UI should not remain heavy for every visited tab. Avoid global subscriptions and DB writes on hidden tabs unless necessary.
- Be careful with React `<Activity>`: it preserves component state but may not prevent expensive hidden work. If keeping `<Activity>`, ensure hidden panes do not subscribe/map/materialize unnecessarily. If removing or reducing full hidden panes, preserve drafts via existing `useChatDraft` DB storage and preserve enough scroll state for good UX.
- Be careful with event-log correctness: long chats, branch navigation, event-log rebuilds, queue drafts, streaming updates, and session movement between scopes/worktrees must not show stale messages. A safe cache invalidation rule is better than an overly clever incremental algorithm.
- Be careful with file entries: `FileIndexContext.Provider value={files}` and Composer `files={files}` may have downstream expectations. Prefer an adapter that can support old array consumers during migration if needed, but the final hot path should not eagerly derive thousands of entries just because a tab became visible.
- Suggested Playwright flow if dev launch works: start app with `ZENBU_CDP_PORT=9225 pnpm dev --verbose`; enable/reset `window.__zenbuPerf` and `window.__zenbuDbTrace`; switch between a few existing chat tabs including one long chat; create a new tab; send a short prompt in an existing warm chat and verify user prompt and reply render; check idle DB trace returns to repo polling. Force-click tab tests may be useful because normal Playwright locator actionability can over-wait on the tab strip.
- 2026-06-18: Commit 1 implemented a renderer MRU materialized-message cache with event-log shape fingerprinting and focused cache tests; `ChatPane` now uses it for normal materialization spans.
- 2026-06-18: Commit 2 replaced hidden chat `<Activity>` panes with a dormant shell so inactive chat tabs no longer retain ChatPane/Composer/ChatDisplay/session-subscribe work; view tabs still use `<Activity>` for iframe warmth.
- 2026-06-18: Commit 3 lets revealed chats paint from the MRU materialized cache while `useCollection` catches up, then live materialization updates the cache once events arrive; `ChatDisplay` now restores saved scroll position for dormant-tab remounts.
- 2026-06-18: Commit 4 replaced eager `FileEntry[]` derivation with a lazy `FileEntryProvider`; composer searches paths on demand and only builds the full path set when documents contain `@` file references. Added provider tests.

## Final notes and learnings
- Implementation completed all four planned commits.
- Final validation: `pnpm run typecheck` passed; targeted Vitest command for materialized-message cache and file-entry provider passed (5 files / 23 tests due repo Vitest config includes related suites).
- Playwright/dev-client validation was attempted but not feasible in this worktree: `pnpm dev --verbose` exits immediately with `sh: zen: command not found`, so no CDP/browser session could be launched here. Manual verification should run in a fully linked app environment.
