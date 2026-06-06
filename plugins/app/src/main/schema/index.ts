import { createSchema, z } from "@zenbujs/core/db";
import type { InferSchemaRoot } from "@zenbujs/core/db";

import {
  repo,
  workspace,
  scope,
  terminal,
  fileTreeIndex,
} from "./workspace";
import {
  session,
  sessionMeta,
  killedSession,
  reloadToast,
  chat,
  chatState,
  chatWindowState,
} from "./session";
import { windowState } from "./window";
import {
  env,
  recentProject,
  paletteAction,
  slashCommand,
  modelInfo,
  settings,
  pluginListing,
  pluginIcon,
} from "./app";
import { providerStatus, oauthFlow } from "./auth";

/**
 * Records are tables with a single built-in index. We use them
 * instead of arrays so mutations are O(1) instead of O(N).
 */
const schema = createSchema({
  repos: z.record(z.string(), repo).default({}),
  workspaces: z.record(z.string(), workspace).default({}),
  scopes: z.record(z.string(), scope).default({}),
  chats: z.record(z.string(), chat).default({}),
  sessions: z.record(z.string(), session).default({}),
  windowStates: z.record(z.string(), windowState).default({}),
  chatStates: z.record(z.string(), chatState).default({}),
  terminals: z.record(z.string(), terminal).default({}),
  fileTreeIndexes: z.record(z.string(), fileTreeIndex).default({}),
  models: z.record(z.string(), modelInfo).default({}),
  sessionMeta: z.record(z.string(), sessionMeta).default({}),
  /** Sessions whose in-flight agent run was killed by a hot reload
   * or shutdown. Surfaced as a Continue/Dismiss toast. */
  killedSessions: z.record(z.string(), killedSession).default({}),
  /** Renderer-consumed signal: session id → auto-resume timestamp,
   * written when main silently resumes after a hot reload. */
  pendingReloadToasts: z.record(z.string(), reloadToast).default({}),
  chatWindows: z.record(z.string(), chatWindowState).default({}),
  // `playConfigs`, `openInApps`, and `piExtensions` used to live here.
  // They moved to the `play`, `openIn`, and `pi` plugins respectively.
  // to the `play` and `openIn` plugins respectively when the
  // title-bar buttons were isolated; migration `0046` drops both.

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
  /**
   * Snapshot of every provider's auth status. Rebuilt on every
   * boot and after every auth mutation by `AuthService`. No
   * secrets — values come from `AuthStorage.getAuthStatus()`.
   */
  providerStatuses: z.record(z.string(), providerStatus).default({}),
  /**
   * Currently-running OAuth login flow, or `null` when idle.
   * Driven by `AuthService` as pi calls back through
   * `auth.login()`'s callbacks; the renderer's global modal reads
   * this directly. At most one flow at a time — starting a second
   * `/login` aborts the first.
   */
  oauthFlow: oauthFlow.nullable().default(null),
  env: env.default({ homeDir: null }),
  settings: settings.default({
    theme: "system",
    chatBackground: null,
    vimMode: true,
    defaultSendMode: "followUp",
    chatDevtools: false,
    disableTelemetry: false,
  }),
});

export default schema;
export type Schema = InferSchemaRoot<typeof schema>;
