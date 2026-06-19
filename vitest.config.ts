import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    // Only our workspace sources. Without this vitest sweeps up spec
    // files inside `.zenbu/` install caches (e.g. .node-gyp/.bun) and
    // fails on packages' own test suites.
    include: [
      "plugins/**/*.{test,spec}.{ts,tsx}",
      "packages/**/*.{test,spec}.{ts,tsx}",
    ],
    exclude: ["**/node_modules/**", "**/.zenbu/**", "**/dist/**"],
    // No test files exist yet; keep `pnpm test` a meaningful green
    // gate instead of an error until the first test lands.
    passWithNoTests: true,
  },
})
