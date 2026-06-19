/**
 * Inline divider rendered in place of the sentinel user-message
 * `SessionsService.continueKilled` dispatches after a hot-reload
 * auto-resume. Mirrors the look of `<Interrupted />` so the two
 * sit at the same visual layer in the chat history.
 *
 * The wrapped "<system>Continue. The system reloaded.</system>"
 * text that the model actually receives is intentionally hidden
 * here — the chat history reads as one continuous turn, with the
 * divider hinting that the agent loop was bounced.
 */
export function AgentReloaded() {
  return (
    <div className="flex items-center gap-3 px-3 py-2">
      <div className="h-px flex-1 bg-border" />
      <span className="select-none text-xs text-muted-foreground">
        Agent reloaded
      </span>
      <div className="h-px flex-1 bg-border" />
    </div>
  )
}
