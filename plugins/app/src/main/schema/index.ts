import { createSchema, z } from "@zenbujs/core/db";
import type { InferSchemaRoot } from "@zenbujs/core/db";

import {
  repo,
  workspace,
  scope,
  terminal,
  fileTreeIndex,
} from "./workspace";
import { chat, chatState, chatWindowState } from "./session";
import { windowState } from "./window";
import {
  env,
  recentProject,
  paletteAction,
  slashCommand,
  settings,
  pluginListing,
  pluginIcon,
  pluginLoadIssue,
} from "./app";

/**
 * Records are tables with a single built-in index. We use them
 * instead of arrays so mutations are O(1) instead of O(N).
 */
const schema = createSchema({
  repos: z.record(z.string(), repo).default({}),
  workspaces: z.record(z.string(), workspace).default({}),
  scopes: z.record(z.string(), scope).default({}),
  chats: z.record(z.string(), chat).default({}),
  windowStates: z.record(z.string(), windowState).default({}),
  chatStates: z.record(z.string(), chatState).default({}),
  terminals: z.record(z.string(), terminal).default({}),
  fileTreeIndexes: z.record(z.string(), fileTreeIndex).default({}),
  chatWindows: z.record(z.string(), chatWindowState).default({}),
  // `playConfigs`, `openInApps`, and `piExtensions` used to live here;
  // they moved to the `play`, `openIn`, and `pi` plugins respectively.
  // `sessions`, `killedSessions`, `pendingReloadToasts`, `models`,
  // `providerStatuses`, and `oauthFlow` moved to the `pi` plugin with
  // the sessions/auth services (see BREAKING.md) — the pi plugin
  // backfills their data on first evaluate before this drop ships.

  /** Command palette actions contributed by plugins. Wiped +
   * repopulated on every app start (see `paletteAction`). */
  paletteActions: z.record(z.string(), paletteAction).default({}),
  /** Slash commands contributed by plugins. Wiped + repopulated on
   * every app start (see `slashCommand`). */
  slashCommands: z.record(z.string(), slashCommand).default({}),
  /** Folders the user has recently opened in other IDEs. Rewritten
   * on every boot, so stale entries vanish on next launch. */
  recentProjects: z.record(z.string(), recentProject).default({}),
  /** Snapshot of the host's resolved plugin list, mirrored from
   * `@zenbujs/core/runtime` by `PluginRegistryMirrorService`.
   * Sorted by name; rebuilt every time the loader regenerates the
   * plugin barrel. */
  plugins: z.array(pluginListing).default([]),
  /** Per-plugin icon metadata keyed by plugin name. Indexed on
   * boot + on every config change. Bytes live in the blob store;
   * the renderer hydrates via the shared image-cache. */
  pluginIcons: z.record(z.string(), pluginIcon).default({}),
  /** Skipped plugin diagnostics from the config loader. */
  pluginLoadIssues: z.array(pluginLoadIssue).default([]),
  env: env.default({ homeDir: null }),
  settings: settings.default({
    theme: "system",
    chatBackground: null,
    vimMode: true,
    defaultSendMode: "followUp",
    chatDevtools: false,
    perfTrace: false,
    disableTelemetry: false,
  }),
});

export default schema;
export type Schema = InferSchemaRoot<typeof schema>;
