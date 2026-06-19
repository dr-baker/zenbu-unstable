# Chat Turn/Tail Materialization

## Goal
Make chat tab reveal scale better for very long chats by moving from whole-chat materialization toward turn-based stable segments plus a live/provisional streaming tail. The current system caches whole materialized chat arrays with an approximate memory budget (`6b2b1cf bound chat materialization cache by memory`), which is good for revisits but still requires whole-history materialization on first load or cache miss. The desired model is: finalized historical turns are stable and cacheable independently; only the current open/streaming tail should be rematerialized live.

Detailed context for the implementer:
- Repo/worktree:
  - Main repo: `/Users/daniel/.zenbu/apps/zenbu`
  - Feature worktree: `/Users/daniel/.zenbu/apps/zenbu/agent_features/.worktrees/chat-turn-tail-materialization`
  - Branch: `feature/chat-turn-tail-materialization`
- Recent relevant commits on `main`:
  - `9576b8a merge chat MRU data warmth`
  - `6b2b1cf bound chat materialization cache by memory`
- Key current files:
  - `plugins/chat/src/renderer/components/chat/lib/materialize.ts`: current whole-log `materializeMessages(events, options)` implementation. This is the correctness baseline.
  - `plugins/chat/src/renderer/components/chat/lib/materialized-message-cache.ts`: current approximate-byte-budget whole-chat cache. Default budget is 24 MiB, keeps newest oversized entry even over budget.
  - `plugins/chat/src/renderer/components/chat/lib/materialized-message-cache.test.ts`: existing cache tests.
  - `plugins/chat/src/renderer/components/chat/lib/materialize.compaction.test.ts`: important correctness tests for compaction/branch summary behavior.
  - `plugins/chat/src/renderer/components/chat/chat-pane.tsx`: currently calls `peekCachedMaterializedMessages` when `events.length === 0`, and `getCachedMaterializedMessages(events, materializedCacheKey)` otherwise.
  - `plugins/chat/src/renderer/components/chat/chat-display.tsx` and `message-list.tsx`: windowed render and scroll restore.
  - `plugins/app/src/renderer/components/layout/chat-pane-container.tsx`: hidden chat tabs are dormant shells; do not undo this.
- Current behavior to preserve:
  - Hidden chat tabs should remain dormant; do not keep full hidden `ChatPane`/Composer/ChatDisplay trees alive.
  - Opening/switching a chat tab should not activate Pi by itself.
  - Lazy file entries should stay lazy; do not reintroduce eager `chat.file_paths.map`/`chat.file_entries.derive` work on ordinary tab switch.
  - Whole-chat materialization should remain available as a safe fallback until the turn/tail path is proven equivalent.
  - Current cache is byte-budgeted, not fixed-count; preserve approximate memory accounting and newest-oversized retention.

Design discussion to carry forward:
- We do not need to blindly materialize entire chats forever. Most old history is stable after a turn is finalized. The important split is:
  - Stable finalized turns: cache independently by segment/turn identity.
  - Current open streaming tail: rematerialize live from tail events as updates arrive.
- For a streaming chat when switching back, render stable cached materialized turns immediately plus a small live tail. When streaming ends, promote that tail into the stable turn cache.
- Avoid a naive arbitrary slice of the last N events. It can cut through a message/tool lifecycle. Use natural segment/turn boundaries instead.
- A practical segment is roughly user prompt through terminal `agent_end`/abort/error for that turn. The current streaming/open turn remains provisional. If terminal status is ambiguous, leave it in the live tail and fall back conservatively.
- The current `materializeMessages` has some stateful details: assistant message assembly, tool lifecycle, turn summaries, permission/tool status, user message indexes for edit/revert, branch/clone markers, compaction/branch summaries, and directory/workspace-sensitive file summaries. The refactor should either preserve those via shared state helpers or compare/fallback to whole materialization.
- The goal is not to delete the whole materializer. The goal is to add a clean segmented model around it, keep full materialization as correctness fallback, and use partial/tail output when safe.

Edge cases and requirements to account for:
- No materialized cache yet / first visit: should still render correctly. Prefer a safe tail if a boundary is available; otherwise full materialization fallback.
- Empty/new chat: return empty messages immediately.
- Streaming with no stable turns: materialize the open tail from the first user prompt/current segment onward.
- Streaming with stable history: cached completed turns plus live open tail.
- Huge single turn/tool loop: newest oversized segment/tail should still be cacheable or at least render correctly; do not make a single huge chat impossible to reveal.
- Tool-call lifecycle: never split inside the current tool lifecycle unless the state machine supports it. Segment at turn boundaries.
- Agent abort/killed/error: terminal abort/error/agent_end can close a stable segment when UI can render it as finalized; ambiguous status stays provisional.
- Queued/follow-up messages while streaming: `QueuedMessages` is separate session DB state and should remain live. If a follow-up becomes a new user prompt, it starts a new segment.
- Branch navigation/rewind/event-log rebuild: collection id and/or segment event shape should invalidate affected segment cache entries.
- Session moved to another scope/worktree: directory/workspace/scope are part of cache identity because file summaries/path rendering can differ.
- Compaction/branch summary events: test against existing compaction materialization tests. Treat as boundaries or include in neighboring stable segment conservatively.
- Event collection initially empty on remount: render cached stable/tail reveal if available; if no cache, render empty/loading briefly and hydrate safely.
- Cache has stale tail while tab hidden: stable turns can render immediately, but provisional streaming tail must be replaced by current event data once loaded.
- User message indexes for edit/revert: partial assembly must not reset visible user-message indexes to zero incorrectly. Store/derive base user index per segment or assemble indexes globally.
- Scroll position: preserve existing scroll restore behavior. If user is locked to bottom, stay near bottom as live tail updates; if mid-history, restore saved scroll and avoid jumping as tail/full hydration catches up.
- Find-in-chat: partial loaded messages may be incomplete. Either trigger full hydrate before/for search, or keep search scoped to currently loaded messages with clear behavior. Prefer correctness over incomplete silent results.
- Fork/edit/revert controls: visible loaded segments must have correct user indexes/entry ids. Hidden/unloaded older segments do not render controls.
- Pending permission requests: current tail must stay live; completed old permission cards can be stable.
- Images/uploads: cache metadata/references, not bytes; existing image cache should keep handling lazy hydration.
- Memory pressure: segmented/turn cache should share or replace the existing byte budget, not double memory indefinitely.
- Dev/profiling validation: keep or add perf marks that distinguish stable segment hits, live tail materialization, full fallback, and background/full hydration so Playwright can verify behavior.

Validation expectations:
- Run `pnpm run typecheck`.
- Run relevant Vitest suites, including existing materialization/cache tests and any new segment/tail tests.
- Try dev + Playwright in the worktree if feasible. If the worktree cannot launch due to `zen`/linking/profile issues, document that clearly and still run typecheck/tests. If Playwright is feasible, validate tab switching on long chats, switching back while/after streaming, new chat, send, idle DB trace, and perf spans showing tail/segment cache behavior.
- Do not paste full renderer URLs or websocket-token URLs in notes/output.

## TODO
- [x] Define and test turn/tail segmentation and stable segment identity for chat event logs.
- [x] Implement a byte-budgeted segmented materialization cache with safe whole-materialization fallback.
- [x] Wire ChatPane reveal/rendering to use cached stable turns plus live tail while preserving scroll, editing, search, and streaming correctness.
- [x] Validate performance and correctness with typecheck, tests, and best-effort Playwright/logging.

## Progress Notes
- 2026-06-18: FeatureFlow run requested in background mode, ignoring dirty main worktree issues. The task is to evolve from whole-chat byte-budget MRU caching to stable finalized-turn caching plus a live/provisional streaming tail, with conservative fallbacks and strong edge-case coverage.

## Final notes and learnings
- Implemented conservative `agent_end`-bounded stable segments; anything after the last safe finalized segment stays in the live tail.
- Segment materialization carries a base user-message index so edit/revert controls retain whole-log indexing.
- The byte-budgeted cache now stores whole-chat fallback entries and stable turn segments in one MRU budget; empty remount reveal snapshots are bounded references to stable segment messages and omit stale provisional tails.
- `eventLogShape` now includes a stable payload hash so rebuilt logs with identical seq/kind/timestamp but changed payloads invalidate cache entries.
- Validation passed with `PATH=/Users/daniel/.zenbu/apps/zenbu/node_modules/.bin:$PATH` because this worktree has no local `node_modules`; direct `pnpm test ...` failed before adding that PATH. Playwright validation was blocked because `pnpm exec playwright --version` reported `Command "playwright" not found`.
