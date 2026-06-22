---
name: zenbu-playwright-agent
description: Validate Zenbu Electron/UI changes with a Playwright subagent. Use when asked to run Playwright, Electron, CDP, UI smoke tests, screenshots, or browser validation in this repo, especially after renderer/plugin changes.
compatibility: Pi coding agent in the Zenbu app repo.
---

# Zenbu Playwright Agent Validation

Use this skill for Zenbu UI/Electron validation after code changes. Prefer a focused Playwright subagent so the parent agent keeps context small, but make the subagent exit cleanly.

If this skill was just created or edited during the current conversation, tell the user/parent that Pi may need `/reload` or a restart before fresh subagents automatically see it. Until then, paste the critical runtime/cleanup instructions directly into the subagent task.

## Core Rule

The Playwright subagent should validate and summarize; it must not wait forever on `pnpm dev` or leave Electron running.

## Before Delegating

1. Run `subagent({ action: "list" })` and use an available Playwright-capable validator agent.
2. Give the subagent a compact handoff:
   - changed files and the relevant diff summary
   - exact behavior to validate
   - selectors/text to assert
   - artifact paths under `/tmp`
   - the cleanup requirement below
3. Avoid pasting giant perf traces, websocket-token URLs, or full JSON artifacts into the main context.

## Zenbu Dev Runtime

Use CDP port `9225`:

```bash
ZENBU_CDP_PORT=9225 pnpm dev --verbose > /tmp/zenbu-<task>-dev.log 2>&1 &
echo $! > /tmp/zenbu-<task>-dev.pid
```

Before starting dev, kill stale Zenbu/Electron processes that may hold the DB lock:

```bash
pkill -f 'remote-debugging-port=9225' 2>/dev/null || true
pkill -f 'zen dev --verbose' 2>/dev/null || true
```

Wait for `[zenbu] ready` in the log, not for the dev command to exit.

## Playwright Pattern

- Connect over CDP: `chromium.connectOverCDP("http://127.0.0.1:9225")`.
- Use `domcontentloaded` plus short explicit waits.
- Do **not** use `networkidle`; Zenbu keeps websocket/HMR connections open.
- Keep optional locator waits short (usually 2–5 seconds).
- Write a concise JSON artifact under `/tmp/zenbu-<task>.json`.
- Take screenshots only when useful, under `/tmp/zenbu-<task>.png`.
- Return pass/fail, artifact paths, and a short list of assertions.

## Required Cleanup

The subagent must use a trap/finally-style cleanup and kill the dev Electron process before returning. Do not leave cleanup as a reminder in prose only; include it in the exact shell/script the subagent runs:

```bash
cleanup() {
  pkill -f 'remote-debugging-port=9225' 2>/dev/null || true
  pkill -f 'zen dev --verbose' 2>/dev/null || true
}
trap cleanup EXIT
```

If the subagent writes a passing artifact but times out, treat that as harness cleanup/finalization failure, not necessarily a UI failure. Inspect the artifact first. If no artifact exists and Electron is still running, kill Electron and run a compact direct CDP probe from the parent.

## Suggested Validator Task Shape

```text
Validate the Zenbu UI change with Playwright/CDP.

Context:
- Changed files: ...
- Expected behavior: ...
- Must not expose wsToken URLs or large raw JSON.

Runtime:
- Kill stale port 9225 Electron/dev processes first.
- Start `ZENBU_CDP_PORT=9225 pnpm dev --verbose` in the background.
- Wait for `[zenbu] ready` in `/tmp/zenbu-<task>-dev.log`.
- Connect with Playwright over CDP at `http://127.0.0.1:9225`.
- Avoid `networkidle`; use domcontentloaded and short waits.
- Always cleanup Electron/dev processes before final response.

Assertions:
- ...

Artifacts:
- `/tmp/zenbu-<task>.json`
- optional screenshot `/tmp/zenbu-<task>.png`

Return only a concise pass/fail summary with artifact paths.
```

## Parent Follow-up

After the subagent returns:

1. Read only the concise summary first.
2. If it timed out, check whether the JSON artifact exists and whether it says `pass: true`.
3. If no artifact exists, run a compact direct CDP probe from the parent rather than rerunning a broad validation immediately.
4. Clean up dev Electron if the subagent did not.
