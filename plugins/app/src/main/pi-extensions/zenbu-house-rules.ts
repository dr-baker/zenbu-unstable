import { existsSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

import type { ExtensionFactory } from "@earendil-works/pi-coding-agent"

/**
 * Inject Zenbu's house rules / plugin-authoring guide into every
 * embedded session's system prompt.
 *
 * The whole point of this app is that the user can modify it at
 * runtime. For that to work, the agent needs to know:
 *
 *   1. This app is a Zenbu.js app.
 *   2. *Where* the Zenbu source lives on this machine (`$ZENBU`).
 *   3. Which docs explain how to author plugins, services, schema,
 *      events, views, etc.
 *
 * We resolve the Zenbu root from the host app config path populated by
 * Zenbu.js setup-gate. That path identifies the running app, not the
 * user's active project/session directory.
 */

type PackageJson = { name?: string }

function isZenbuIdeRoot(dir: string): boolean {
  if (!existsSync(join(dir, "zenbu.config.ts"))) return false
  try {
    const pkg = JSON.parse(
      readFileSync(join(dir, "package.json"), "utf8"),
    ) as PackageJson
    return pkg.name === "zenbu"
  } catch {
    return false
  }
}

/** Resolve the absolute path of the running Zenbu IDE app checkout. */
function resolveZenbuRoot(): string | null {
  const configPath = process.env.ZENBU_CONFIG_PATH?.trim()
  if (!configPath) return null

  const root = dirname(resolve(configPath))
  return isZenbuIdeRoot(root) ? root : null
}

function hasFrameworkDocs(root: string): boolean {
  return existsSync(join(root, "context/zenbujs"))
}

function docsLines(root: string): string[] {
  const docs = [
    {
      path: "AGENTS.md",
      text: "start here: house rules + plugin authoring guide",
    },
    { path: "context/rules/AGENTS.md", text: "house rules in detail" },
    {
      path: "context/zenbujs",
      text: "framework reference, one file per topic",
    },
  ].filter(doc => existsSync(join(root, doc.path)))

  if (docs.length === 0) return []

  return [
    "Before doing any app work, read the available house rules and framework docs:",
    "",
    ...docs.map(doc => `- \`$ZENBU/${doc.path}\` — ${doc.text}.`),
    "",
  ]
}

function houseRulesPrompt(root: string): string {
  return [
    "# Zenbu app — editing this app",
    "",
    "This app is itself a **Zenbu.js** app, and the user can modify it at",
    "runtime. When the user asks you to change, extend, or build features",
    "for the app (new sidebars, views, panes, services, slash commands,",
    "plugins, etc.), treat the Zenbu source checkout as your project.",
    "",
    `The Zenbu source lives at (call this \`$ZENBU\`):`,
    "",
    `    ${root}`,
    "",
    ...docsLines(root),
    "Monorepo layout:",
    "",
    `- \`$ZENBU/plugins/*\` — actual Zenbu plugins. Each has a`,
    "  `zenbu.plugin.ts` and ships views/services/schema. To add a feature",
    "  to the app, you almost always create or edit a plugin here.",
    `- \`$ZENBU/packages/*\` — plain npm-style libraries plugins consume`,
    "  (`@zenbu/ui`, `@zenbu/view-theme`). Shared libs go here.",
    "",
    "Key rules to follow:",
    "",
    "- A plugin extends the app three ways: fill a slot (injection with a",
    "  matching `meta.kind`), emit/subscribe to `events.app.*`, or wrap an",
    "  export with advice.",
    "- The DB section name matches the plugin `name` (camelCase). Never",
    "  write to `db.app.*` from another plugin.",
    "- Run `pnpm run db:generate` after schema changes; migrations go in",
    "  `<plugin>/migrations/`.",
    "- Injection names are global — prefix them with the plugin name.",
    "- `react`, `react-dom`, `@zenbujs/core`, and `@zenbu/ui` are provided",
    "  by the runtime; do not bundle them.",
    "",
    ...(hasFrameworkDocs(root)
      ? [
          "When unsure how a host capability works, read the matching doc under",
          "`$ZENBU/context/zenbujs/` and the closest existing plugin in",
          "`$ZENBU/plugins/` before writing code.",
        ]
      : [
          "When unsure how a host capability works, read the closest existing",
          "plugin in `$ZENBU/plugins/` before writing code.",
        ]),
  ].join("\n")
}

export function createZenbuHouseRulesExtension(_cwd: string): ExtensionFactory {
  return pi => {
    const root = resolveZenbuRoot()
    if (!root) return

    pi.on("before_agent_start", event => ({
      systemPrompt: `${event.systemPrompt}\n\n${houseRulesPrompt(root)}`,
    }))
  }
}
