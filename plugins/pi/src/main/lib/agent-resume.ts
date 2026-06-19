/**
 * Sentinel text dispatched by `SessionsService.continueKilled` to
 * resume an agent after a hot-reload or quit. The model receives the
 * wrapped text verbatim ("Continue. The system reloaded.") and picks
 * up where it left off; the chat-surface materializer recognises
 * this exact string and renders a thin "Agent reloaded" divider in
 * place of the user-message bubble.
 *
 * Shared between main (writer) and renderer (reader) so the two
 * sides can't drift. The constant lives in `main/lib` because main
 * owns the resume pipeline; the renderer's materializer is the only
 * other consumer.
 */
export const SYSTEM_RELOAD_SENTINEL =
  "<system>Continue. The system reloaded.</system>"
