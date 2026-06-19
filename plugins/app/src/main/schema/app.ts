import { z } from "@zenbujs/core/db";

/**
 * One row per plugin loaded by the host, mixed with one row per
 * locally-installed pi extension. Mirrored on every
 * `PluginRegistryMirrorService.evaluate()`. Backs the plugins
 * root view's left sidebar.
 *
 *  - `name`: stable id. For zenbu plugins, matches `definePlugin({ name })`.
 *    For pi extensions, the basename of the source file without the
 *    `.ts` extension.
 *  - `dir`: absolute path. For zenbu plugins this is the plugin
 *    directory; for pi extensions it's the absolute file path of
 *    the extension `.ts`.
 *  - `kind`: row provenance. Drives the detail-pane affordances
 *    (e.g. "Edit in workspace" is only meaningful for zenbu
 *    plugins).
 *  - `tag`: optional chip rendered next to the name. `"core"`
 *    means the plugin's directory sits inside the host repo's
 *    `plugins/` tree; `"pi"` means it's a pi-agent extension
 *    discovered under `~/.pi/agent/extensions`; `null` means it's
 *    an ordinary installed zenbu plugin (no chip).
 *  - `enabled`: whether the plugin is loaded. Disabled plugins stay
 *    in the list (with their icon) so the UI can show them as off.
 *  - `description` / `author` / `version` / `dependencies`: from the
 *    plugin's `package.json` / `zenbu.plugin.ts` at index time.
 *  - `updatedAt`: best-effort local source mtime, ISO encoded.
 *  - `pluginFile`: manifest entry path used to enable/disable/remove;
 *    `null` for core plugins and pi extensions.
 */
export const pluginListing = z.object({
  name: z.string(),
  dir: z.string(),
  kind: z.enum(["plugin", "pi-extension"]).default("plugin"),
  tag: z.enum(["core", "pi"]).nullable().default(null),
  enabled: z.boolean().default(true),
  description: z.string().nullable().default(null),
  author: z.string().nullable().default(null),
  version: z.string().nullable().default(null),
  dependencies: z.array(z.string()).default([]),
  updatedAt: z.string().nullable().default(null),
  pluginFile: z.string().nullable().default(null),
});

/**
 * Per-plugin icon metadata. Lives in a separate map (keyed by
 * plugin name) so changes to the plugin list don't churn icon
 * blobs and vice versa. Convention: indexer looks for
 * `<plugin-dir>/assets/icon.png` first, then `assets/icon.svg`,
 * then root-level fallbacks.
 */
export const pluginIcon = z.object({
  blobId: z.string(),
  mime: z.string(),
  sourcePath: z.string(),
  hash: z.string(),
});

export const pluginLoadIssue = z.object({
  manifestFile: z.string(),
  pluginFile: z.string(),
  reason: z.string(),
  suggestion: z.string().nullable().default(null),
});

// ---------------------------------------------------------------------------
// Process environment exposed to the renderer without an RPC round-trip.
// Populated by InitService on every boot.
// ---------------------------------------------------------------------------

export const env = z.object({
  homeDir: z.string().nullable().default(null),
});

// ---------------------------------------------------------------------------
// Recent projects: folders the user opened in other IDEs on this
// machine. Indexed by `RecentProjectsService` on every boot — the
// record is truncated and rewritten, so stale entries vanish on
// next launch. Surfaced on the onboarding view.
// ---------------------------------------------------------------------------

const recentProjectSource = z.enum([
  "code",
  "cursor",
  "windsurf",
  "antigravity",
  "trae",
]);

export const recentProject = z.object({
  /** Stable id = sha1(path). */
  id: z.string(),
  /** Absolute local path; always a real directory when written. */
  path: z.string(),
  /** `path.basename(path)`, denormalized for the renderer. */
  name: z.string(),
  /** Unix ms; max `lastOpenedAt` across `sources`. */
  lastOpenedAt: z.number(),
  /** Which IDEs reported this folder. */
  sources: z.array(recentProjectSource),
});

// The `openInApp` shape used to live here. It moved to
// `plugins/open-in/src/main/schema.ts` along with the rest of the
// Open-in plugin. The host's `app.openInApps` record is removed
// by migration `0046`.

// ---------------------------------------------------------------------------
// Plugin contributions. Registrations are runtime-only: the owning
// service wipes the record on every `evaluate()` and plugins
// re-register from their own `setup()` blocks, so removed plugins
// never leave dangling entries.
// ---------------------------------------------------------------------------

/**
 * A command palette action contributed by a plugin.
 * `rpc.{plugin,service,method}` is dispatched in the main process
 * when the user picks the action, always with `{ windowId }` plus
 * the registered `args` (registered values win on collision).
 *
 * Used to carry an `icon` (inline SVG) field too — dropped in favour
 * of a label-only palette so registrants stop being tempted to ship
 * 200-byte SVG strings for rows that are 99% read as text anyway.
 */
export const paletteAction = z.object({
  id: z.string(),
  label: z.string(),
  hint: z.string().nullable().default(null),
  /** Optional category header in the palette. */
  group: z.string().nullable().default(null),
  rpc: z.object({
    plugin: z.string(),
    service: z.string(),
    method: z.string(),
  }),
  /** Extra args merged into dispatch — lets one RPC method back
   * multiple palette rows (e.g. `focusPane({ index: N })`). */
  args: z.record(z.string(), z.unknown()).nullable().default(null),
});

/**
 * A slash command contributed by a plugin.
 *
 * Mirrors command-palette actions, but with chat/composer context.
 * The renderer dispatches `rpc.{plugin}.{service}.{method}` with
 * `{ windowId, chatId, sessionId, command, text, argsText }` plus
 * registered `args`. The handler can return a small client action
 * (toast, open composer panel, close current chat) or do everything
 * via DB/events and return nothing.
 */
export const slashCommand = z.object({
  id: z.string(),
  /** Invoked as `/${name}`. No leading slash. */
  name: z.string(),
  label: z.string(),
  description: z.string().nullable().default(null),
  hint: z.string().nullable().default(null),
  group: z.string().nullable().default(null),
  source: z.string().nullable().default(null),
  rpc: z.object({
    plugin: z.string(),
    service: z.string(),
    method: z.string(),
  }),
  args: z.record(z.string(), z.unknown()).nullable().default(null),
  /** If true, selecting the menu item inserts `/${name} ` instead
   * of running immediately. Typed Enter still dispatches. */
  insertOnSelect: z.boolean().default(false),
});

// ---------------------------------------------------------------------------
// User-visible settings + the model catalog the picker reads from.
// ---------------------------------------------------------------------------

const theme = z.enum(["light", "dark", "oled", "system"]);

const chatBackground = z.object({
  blobId: z.string(),
  mimeType: z.string(),
  opacity: z.number(),
});

/**
 * What "Enter" does in the composer while the agent is streaming.
 * Steer interjects before the next LLM call; followUp queues to
 * run after the current turn. Mod-Enter / `/steer` force steer;
 * `/queue` forces followUp. Ignored when idle.
 */
const defaultSendMode = z.enum(["steer", "followUp"]);

// The Open-in plugin used to live in this schema as
// `defaultOpenInBundlePath` + `finderDefaultMigrated`. Both fields
// moved to `root.openIn.settings` when the title-bar buttons were
// isolated into their own plugins; migration `0046` drops them.
export const settings = z.object({
  theme: theme,
  chatBackground: chatBackground.nullable().default(null),
  vimMode: z.boolean().default(true),
  defaultSendMode: defaultSendMode.default("followUp"),
  /** Show the chat invariant overlay pill. */
  chatDevtools: z.boolean().default(false),
  /** When true, the renderer's analytics service does not send any
   * data to PostHog and opts out of capture. */
  disableTelemetry: z.boolean().default(false),
});
