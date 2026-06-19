# Pi Resource Runtime State

## Goal
Represent Pi resources and runtime capabilities first-class in Zenbu without executing extension code for static discovery: per-scope static catalogs, append/update-only resource definitions, persisted session runtime snapshots, and focused-session consumers for runtime commands/skills.

## TODO
- [x] Add typed Pi DB schema for resource definitions, static catalogs, runtime snapshots, and catalog settings/freshness metadata.
- [x] Implement static catalog discovery service using Pi's non-executing package resolver plus Zenbu-provided extension contributions.
- [x] Wire catalog refresh/dirty lifecycle for boot, focus/open scopes, settings/contribution changes, and bounded preloading.
- [x] Capture persisted runtime snapshots from live Pi sessions after activation, reload, resources discovery, and capability-changing lifecycle events.
- [x] Mark runtime snapshots inactive on live session disposal while preserving last-known data for fast old-chat rendering.
- [x] Replace compatibility runtime command flow with focused-session runtime snapshot consumers, updating pi-auto-commands/skill-pills patterns as needed.
- [x] Add stale-session derivation helpers and UI-ready data for current-scope/session resource state.
- [x] Add focused tests for hashing, catalog shape, runtime snapshot capture, and consumer selection.
- [x] Run db generation, typechecks, relevant tests, and source build.
- [x] Commit distinct feature slices with audit-friendly messages.

## Progress Notes
- 2026-06-17: Created feature worktree at `agent_features/.worktrees/pi-resource-runtime-state` on branch `feature/pi-resource-runtime-state` from `app-decomposition`.
- 2026-06-17: Reconfirmed architecture decisions: static catalogs are non-executing; runtime-only resources update definitions as `runtime`; definitions persist append/update-only; snapshots persist after dispose as inactive cached data.
- 2026-06-17: Landed audit-friendly commits for plan, schema, registry/capture, chat/skill-pills consumers, Pi sidebar UI, pure helper tests, and resource watcher refresh.
- 2026-06-17: Migrated external `~/.zenbu/plugins/pi-auto-commands` on branch `feature/pi-resource-runtime-state-consumer` to read focused session snapshots with legacy `runtimeCommands` fallback.
- 2026-06-17: Validated changed Zenbu plugins with `tsc` for pi/chat/skill-pills, focused Vitest helper tests, full Vitest, root `pnpm run typecheck`, and `zen build:source`.
- 2026-06-17: Final cleanup kept the renderer Pi resource view off Node-only helper imports, then re-ran the validation set successfully at `65a21ac`.
- 2026-06-17: Follow-up review tightened refresh races: catalog dirtied during an in-flight resolve now stays dirty and queues a second refresh, resource definitions now track static/runtime/both discovery provenance, and the active chat emits a one-shot stale Pi resource warning.

## Final notes and learnings
- `db:generate` must run from `plugins/pi/` with the main checkout's `zen` binary; then `zen link` for typed deps when needed.
- `chat-pane` now renders runtime slash commands directly from session snapshots; global runtime command registry data is no longer the UI source of truth.
- Static catalog watching is bounded to preloaded/focused scopes plus user Pi dirs. File edits may trigger a refresh, but staleness still derives only from activation hashes, not mtime/size/content.
- Refresh dirty handling intentionally preserves dirty metadata when activation/config changes land during a resolver pass, then queues a follow-up refresh so the catalog cannot silently appear current with pre-change inputs.
- `typecheck:all` still fails on unrelated pre-existing generated-type issues in agent-sidebar/app renderer slices; changed plugins typecheck clean.
