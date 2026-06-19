import { z } from "@zenbujs/core/db"

// ---------------------------------------------------------------------------
// Auth / provider credential surface.
//
// Pi stores the actual credentials (OAuth tokens + API keys) in
// `~/.pi/agent/auth.json` via its `AuthStorage` — we do NOT replicate
// secrets into the renderer-visible db. What we DO mirror is the
// presence-and-source status, plus any in-flight OAuth flow state, so
// the renderer can render UI without round-trips and without ever
// touching credential values.
//
// `AuthService` (`src/main/services/auth.ts`) rebuilds `providerStatus`
// on every boot and after every mutation, and drives `oauthFlow`
// during a `/login`-style flow.
// ---------------------------------------------------------------------------

/**
 * Where a provider's credential is coming from. Mirrors
 * `AuthStorage.AuthStatus["source"]` so the renderer can show a
 * meaningful badge ("Connected" vs "via environment").
 */
const authSource = z.enum([
  "stored",
  "runtime",
  "environment",
  "fallback",
  "models_json_key",
  "models_json_command",
])

/**
 * Snapshot of one provider's auth state. No secret material.
 */
export const providerStatus = z.object({
  /** Provider id, e.g. `"anthropic"`, `"openai-codex"`. */
  id: z.string(),
  /**
   * What kind of auth this provider expects. Drives the UI:
   * subscription → OAuth login button, apiKey → key input,
   * cloud → "configure in models.json" pointer (v1).
   */
  kind: z.enum(["subscription", "apiKey", "cloud"]),
  /** Human-readable display name ("Claude (Pro/Max)", "OpenAI"). */
  displayName: z.string(),
  /** Whether ANY credential is currently resolvable for this provider. */
  configured: z.boolean(),
  /** Where the credential is coming from when `configured`. */
  source: authSource.nullable().default(null),
  /**
   * Pi's own status label ("OAuth", "API key", "via $ANTHROPIC_API_KEY")
   * — pass-through from `AuthStatus.label`.
   */
  label: z.string().nullable().default(null),
  /**
   * What kind of credential is currently stored for this provider,
   * when `source === "stored"`. Lets the UI render "Connected
   * (OAuth)" vs "Connected (API key)" so users know which path
   * they're on — important for providers like Anthropic that
   * accept *both* an OAuth subscription and a plain API key under
   * the same provider id. `null` when env-only or unconfigured.
   */
  credentialType: z.enum(["oauth", "api_key"]).nullable().default(null),
  /**
   * Environment variable name pi will read from, when applicable.
   * Shown in the UI as "or set `$ANTHROPIC_API_KEY`".
   */
  envVar: z.string().nullable().default(null),
  /**
   * Whether this provider, in addition to its primary auth flow,
   * accepts a plain API key. True for Anthropic (OAuth subscription
   * OR `ANTHROPIC_API_KEY`) and GitHub Copilot (OAuth OR a GH
   * token), false for OAuth-only providers like
   * `openai-codex`. Drives the renderer's "Use API key instead"
   * affordance.
   */
  supportsApiKey: z.boolean().default(false),
})

/**
 * Steps of an OAuth login flow. `auth.login()` calls back into us
 * with `onAuth`, `onSelect`, `onPrompt`, `onManualCodeInput` — each
 * maps to a step here. The renderer renders the modal off the
 * current step; an RPC call from the user advances or cancels.
 */
const oauthFlowStep = z.enum([
  "starting",
  "openUrl",
  "select",
  "prompt",
  "manualCode",
  "completing",
  "error",
])

const oauthSelectOption = z.object({
  id: z.string(),
  label: z.string(),
})

/**
 * Live state of the currently-running OAuth flow. There is at most
 * one in flight per app — the renderer modal is global, and starting
 * a second login cancels the first.
 *
 * Step semantics:
 *  - `starting`: `auth.login()` was just kicked off, no callback yet.
 *    The modal shows a spinner so the user gets immediate feedback.
 *  - `openUrl`: pi gave us a URL via `onAuth`. We've already opened
 *    it with `shell.openExternal`; the modal shows the URL + a
 *    "Open again" button + instructions. If the provider supports
 *    manual code paste (`onManualCodeInput`), we also expose a
 *    "Paste code" affordance — but that's a SEPARATE step (`manualCode`)
 *    that the user opts into, since pi doesn't tell us upfront
 *    whether manual-code is available without calling the callback.
 *  - `select`: pi called `onSelect`; show the options as a radio list.
 *  - `prompt`: pi called `onPrompt` (text input — e.g. GitHub
 *    Enterprise domain).
 *  - `manualCode`: pi called `onManualCodeInput`; the user pastes
 *    the redirect URL or code.
 *  - `completing`: all user input is in; pi is exchanging the code
 *    for a token. Modal shows a spinner.
 *  - `error`: terminal — show the message, offer "Try again".
 */
export const oauthFlow = z.object({
  /** Unique id for this flow — RPC callbacks pass this in. */
  flowId: z.string(),
  /** Pi provider id, e.g. `"anthropic"`. */
  providerId: z.string(),
  /** Display name (mirrored for the renderer's title). */
  displayName: z.string(),
  step: oauthFlowStep,
  /** For `openUrl`: the URL pi told us to open. */
  url: z.string().nullable().default(null),
  /** Free-form text from pi (`onAuth.instructions`). */
  instructions: z.string().nullable().default(null),
  /** For `select`: pi's option list + caption. */
  selectMessage: z.string().nullable().default(null),
  selectOptions: z.array(oauthSelectOption).default([]),
  /** For `prompt`: pi's text-input caption + placeholder. */
  promptMessage: z.string().nullable().default(null),
  promptPlaceholder: z.string().nullable().default(null),
  promptAllowEmpty: z.boolean().default(false),
  /**
   * Whether this provider supports the manual-code paste fallback.
   * Used by the renderer to show the "Paste code instead" affordance
   * during the `openUrl` step.
   */
  supportsManualCode: z.boolean().default(false),
  /** Progress messages from pi (`onProgress`), latest first. */
  progress: z.array(z.string()).default([]),
  /** For `error`: the failure message. */
  errorMessage: z.string().nullable().default(null),
  /** Unix ms. */
  startedAt: z.number(),
})
