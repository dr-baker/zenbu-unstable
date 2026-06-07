import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  defineConfig,
  defineBuildConfig,
  type BuildPlugin,
} from "@zenbujs/core/config";

const UNSTABLE_APP_NAME = "zenbu-unstable";
const STABLE_APP_NAME = "zenbu";

const PROJECT_DIR = path.dirname(fileURLToPath(import.meta.url));

const MIGRATION_DIRS: Record<string, string> = {
  app: "plugins/app/migrations",
  plugins: "plugins/plugins/migrations",
  openIn: "plugins/open-in/migrations",
  settings: "plugins/settings/migrations",
  searchRecentWorkspaces: "plugins/search-recent-workspaces/migrations",
  pluginDev: "plugins/plugin-dev/migrations",
  openProjects: "plugins/open-projects/migrations",
  agentSidebar: "plugins/agent-sidebar/migrations",
  gitTreeSidebar: "plugins/git-tree-sidebar/migrations",
  pi: "plugins/pi/migrations",
  piCommands: "plugins/pi-commands/migrations",
};

/**
 * First-run bootstrap for the unstable channel.
 *
 * `zenbu-unstable` has its own app identity and therefore its own app DB under
 * `~/.zenbu/apps/zenbu-unstable/.zenbu/db`, but Pi session JSONL files already
 * live in the shared `~/.zenbu/pi-sessions` directory. Copying the stable DB on
 * first launch gives unstable the same chat/workspace/session index without
 * sharing a live DB or letting unstable migrations mutate stable's data.
 *
 * This intentionally runs while loading `zenbu.config.ts`, before core opens the
 * DB. The copy is one-way, excludes `.lock`/`.tmp`, validates the copied JSON
 * shape, and refuses to import a stable DB whose recorded section migration
 * versions differ from the versions this unstable build expects.
 */
function bootstrapUnstableDbFromStable() {
  const projectDir = PROJECT_DIR;
  const pkg = readObject(path.join(projectDir, "package.json"));
  if (pkg?.name !== UNSTABLE_APP_NAME) return;

  const unstableDb = path.join(projectDir, ".zenbu", "db");
  const stableDb = path.join(
    os.homedir(),
    ".zenbu",
    "apps",
    STABLE_APP_NAME,
    ".zenbu",
    "db",
  );

  const reset = process.env.ZENBU_UNSTABLE_RESET_FROM_STABLE === "1";
  if (fs.existsSync(path.join(unstableDb, "root.json"))) {
    if (!reset) return;
    fs.rmSync(unstableDb, { recursive: true, force: true });
  }
  if (!fs.existsSync(path.join(stableDb, "root.json"))) return;

  validateStableDbSchema(stableDb);

  const parent = path.dirname(unstableDb);
  fs.mkdirSync(parent, { recursive: true });
  const tmp = path.join(parent, `.db-bootstrap-${process.pid}-${Date.now()}`);
  fs.rmSync(tmp, { recursive: true, force: true });

  try {
    fs.cpSync(stableDb, tmp, {
      recursive: true,
      filter(source) {
        const name = path.basename(source);
        return name !== ".lock" && name !== ".tmp";
      },
    });
    validateCopiedDb(tmp);
    fs.renameSync(tmp, unstableDb);
    console.log(`[zenbu-unstable] copied stable DB from ${stableDb}`);
  } catch (err) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw err;
  }
}

function readObject(file: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function validateStableDbSchema(dbPath: string) {
  const root = readObject(path.join(dbPath, "root.json"));
  const plugins = isRecord(root?._plugins) ? root._plugins : null;
  const versions = isRecord(plugins?.sectionMigrator)
    ? plugins.sectionMigrator
    : null;
  if (!versions || typeof versions !== "object") {
    throw new Error(
      `[zenbu-unstable] Refusing to copy stable DB: missing _plugins.sectionMigrator in ${dbPath}`,
    );
  }

  const expectedSchema = expectedStableDbSchema();
  const mismatches: string[] = [];
  for (const [section, expected] of Object.entries(expectedSchema)) {
    const sectionVersion = versions[section];
    const actual = isRecord(sectionVersion) ? sectionVersion.version : undefined;
    if (actual !== expected) {
      mismatches.push(`${section}: stable=${String(actual)} expected=${expected}`);
    }
  }
  for (const section of Object.keys(versions)) {
    if (!(section in expectedSchema)) {
      const sectionVersion = versions[section];
      const actual = isRecord(sectionVersion) ? sectionVersion.version : undefined;
      mismatches.push(`${section}: stable=${String(actual)} expected=<absent>`);
    }
  }

  if (mismatches.length > 0) {
    throw new Error(
      `[zenbu-unstable] Refusing to copy stable DB because its schema shape differs from this unstable build:\n` +
        mismatches.map(item => `  - ${item}`).join("\n"),
    );
  }
}

function expectedStableDbSchema(): Record<string, number> {
  return {
    core: 8,
    ...Object.fromEntries(
      Object.entries(MIGRATION_DIRS).map(([section, dir]) => [
        section,
        countMigrationFiles(path.join(PROJECT_DIR, dir)),
      ]),
    ),
  };
}

function countMigrationFiles(dir: string): number {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith(".ts"))
      .length;
  } catch {
    return 0;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function validateCopiedDb(dbPath: string) {
  validateStableDbSchema(dbPath);
  for (const file of walkFiles(dbPath)) {
    if (file.endsWith(".json")) {
      JSON.parse(fs.readFileSync(file, "utf8"));
    } else if (file.endsWith(".jsonl")) {
      const lines = fs.readFileSync(file, "utf8").split("\n");
      for (const line of lines) {
        if (line.trim().length > 0) JSON.parse(line);
      }
    }
  }
}

function* walkFiles(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walkFiles(file);
    else if (entry.isFile()) yield file;
  }
}

bootstrapUnstableDbFromStable();

const trimPackageJson: BuildPlugin = {
  name: "trim-package-json",
  transform(file) {
    if (file.path !== "package.json") return;
    const pkg = JSON.parse(file.contents);

    if (pkg.pnpm?.overrides) {
      delete pkg.pnpm.overrides;
      if (Object.keys(pkg.pnpm).length === 0) delete pkg.pnpm;
    }

    if (pkg.scripts) {
      delete pkg.scripts["pnpm:devPreinstall"];
      delete pkg.scripts["dev:link"];
      delete pkg.scripts["dev:unlink"];
      delete pkg.scripts.sync;
      delete pkg.scripts.release;
      delete pkg.scripts["release:source"];
      delete pkg.scripts["release:electron"];
    }

    return JSON.stringify(pkg, null, 2) + "\n";
  },
};

export default defineConfig({
  uiEntrypoint: "./plugins/app/src/renderer",
  pluginsFiles: ["./zenbu.plugins.jsonc", "./zenbu.plugins.local.jsonc"],

  build: defineBuildConfig({
    packageManager: { type: "pnpm", version: "10.13.1" },
    out: ".zenbu/build/source",
    include: [
      "plugins/*/assets/**",
      "plugins/app/src/**",
      "plugins/app/migrations/**",
      "plugins/app/zenbu.plugin.ts",
      "plugins/app/package.json",
      "plugins/app/tsconfig.json",
      "plugins/app/vite.config.ts",
      "plugins/pi/src/**",
      "plugins/pi/migrations/**",
      "plugins/pi/zenbu.plugin.ts",
      "plugins/pi/package.json",
      "plugins/pi/tsconfig.json",
      "plugins/plan/src/**",
      "plugins/plan/zenbu.plugin.ts",
      "plugins/plan/package.json",
      "plugins/plan/tsconfig.json",
      "plugins/code-rendering/src/**",
      "plugins/code-rendering/zenbu.plugin.ts",
      "plugins/code-rendering/package.json",
      "plugins/code-rendering/tsconfig.json",
      "plugins/pi-auto-commands/src/**",
      "plugins/pi-auto-commands/zenbu.plugin.ts",
      "plugins/pi-auto-commands/package.json",
      "plugins/pi-auto-commands/tsconfig.json",
      "plugins/pi-commands/src/**",
      "plugins/pi-commands/migrations/**",
      "plugins/pi-commands/zenbu.plugin.ts",
      "plugins/pi-commands/package.json",
      "plugins/pi-commands/tsconfig.json",
      "plugins/agent-sidebar/src/**",
      "plugins/agent-sidebar/migrations/**",
      "plugins/agent-sidebar/zenbu.plugin.ts",
      "plugins/agent-sidebar/package.json",
      "plugins/agent-sidebar/tsconfig.json",
      "plugins/context-sidebar/src/**",
      "plugins/context-sidebar/zenbu.plugin.ts",
      "plugins/context-sidebar/package.json",
      "plugins/context-sidebar/tsconfig.json",
      "plugins/file-tree-sidebar/src/**",
      "plugins/file-tree-sidebar/zenbu.plugin.ts",
      "plugins/file-tree-sidebar/package.json",
      "plugins/file-tree-sidebar/tsconfig.json",
      "plugins/git-tree-sidebar/src/**",
      "plugins/git-tree-sidebar/migrations/**",
      "plugins/git-tree-sidebar/zenbu.plugin.ts",
      "plugins/git-tree-sidebar/package.json",
      "plugins/git-tree-sidebar/tsconfig.json",
      "plugins/terminal/src/**",
      "plugins/terminal/zenbu.plugin.ts",
      "plugins/terminal/package.json",
      "plugins/terminal/tsconfig.json",
      "plugins/plugins/src/**",
      "plugins/plugins/migrations/**",
      "plugins/plugins/zenbu.plugin.ts",
      "plugins/plugins/package.json",
      "plugins/plugins/tsconfig.json",
      "plugins/open-in/src/**",
      "plugins/open-in/migrations/**",
      "plugins/open-in/zenbu.plugin.ts",
      "plugins/open-in/package.json",
      "plugins/open-in/tsconfig.json",
      "plugins/auto-updater/src/**",
      "plugins/auto-updater/zenbu.plugin.ts",
      "plugins/auto-updater/package.json",
      "plugins/auto-updater/tsconfig.json",
      "plugins/commit-button/src/**",
      "plugins/commit-button/zenbu.plugin.ts",
      "plugins/commit-button/package.json",
      "plugins/commit-button/tsconfig.json",
      "plugins/settings/src/**",
      "plugins/settings/migrations/**",
      "plugins/settings/zenbu.plugin.ts",
      "plugins/settings/package.json",
      "plugins/settings/tsconfig.json",
      "plugins/pi-footer/src/**",
      "plugins/pi-footer/zenbu.plugin.ts",
      "plugins/pi-footer/package.json",
      "plugins/pi-footer/tsconfig.json",
      "plugins/cm-markdown/src/**",
      "plugins/cm-markdown/zenbu.plugin.ts",
      "plugins/cm-markdown/package.json",
      "plugins/cm-markdown/tsconfig.json",
      "plugins/cm-vim/src/**",
      "plugins/cm-vim/zenbu.plugin.ts",
      "plugins/cm-vim/package.json",
      "plugins/cm-vim/tsconfig.json",
      "plugins/cm-image-paste/src/**",
      "plugins/cm-image-paste/zenbu.plugin.ts",
      "plugins/cm-image-paste/package.json",
      "plugins/cm-image-paste/tsconfig.json",
      "plugins/search-recent-agents/src/**",
      "plugins/search-recent-agents/zenbu.plugin.ts",
      "plugins/search-recent-agents/package.json",
      "plugins/search-recent-agents/tsconfig.json",
      "plugins/search-recent-workspaces/src/**",
      "plugins/search-recent-workspaces/migrations/**",
      "plugins/search-recent-workspaces/zenbu.plugin.ts",
      "plugins/search-recent-workspaces/package.json",
      "plugins/search-recent-workspaces/tsconfig.json",
      "plugins/search-recent-worktrees/src/**",
      "plugins/search-recent-worktrees/zenbu.plugin.ts",
      "plugins/search-recent-worktrees/package.json",
      "plugins/search-recent-worktrees/tsconfig.json",
      // `open-projects` ships as part of the onboarding work
      // (recents + project palette). Source + migrations + entry
      // files, same shape as every other tracked plugin.
      "plugins/open-projects/src/**",
      "plugins/open-projects/migrations/**",
      "plugins/open-projects/zenbu.plugin.ts",
      "plugins/open-projects/package.json",
      "plugins/open-projects/tsconfig.json",
      "plugins/plugin-installer/src/**",
      "plugins/plugin-installer/zenbu.plugin.ts",
      "plugins/plugin-installer/package.json",
      "plugins/plugin-installer/tsconfig.json",
      "plugins/plugin-dev/src/**",
      "plugins/plugin-dev/migrations/**",
      "plugins/plugin-dev/zenbu.plugin.ts",
      "plugins/plugin-dev/package.json",
      "plugins/plugin-dev/tsconfig.json",
      "packages/view-theme/**",
      "packages/ui/**",
      ".gitignore",
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "tsconfig.json",
      "zenbu.config.ts",
      "zenbu.plugins.jsonc",
    ],
    ignore: [
      "**/*.test.ts",
      "**/*.test.tsx",
      "**/*.spec.ts",
      "**/*.spec.tsx",
      "**/dev-only/**",
      "**/.zenbu/**",
      "**/node_modules/**",
      "**/.env",
      "**/.env.*",
      "**/dist/**",
      "**/traces/**",
      "**/.DS_Store",
    ],
    plugins: [trimPackageJson],
    mirror: { target: "dr-baker/zenbu-unstable", branch: "main" },
  }),
});
