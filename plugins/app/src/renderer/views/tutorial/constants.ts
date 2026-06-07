// Streaming-pump timings for the tutorial.

/** Shimmer duration before the question text appears in the card. */
export const QUESTION_LOADING_MS = 1050

// Words stream in ~1.5-2.5-word chunks; tokens are
// whitespace-preserving split tokens (~2 per word).
export const CHUNK_MIN_TOKENS = 3
export const CHUNK_MAX_TOKENS = 5
export const CHUNK_INTERVAL_MIN_MS = 95
export const CHUNK_INTERVAL_MAX_MS = 165
export const BETWEEN_ITEM_MS = 600
/** Longer pause before a widget appears so it doesn't snap in. */
export const BEFORE_WIDGET_MS = 300
/** Dwell on a widget before advancing (content needs reading). */
export const AFTER_WIDGET_MS = 5000

export function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}
