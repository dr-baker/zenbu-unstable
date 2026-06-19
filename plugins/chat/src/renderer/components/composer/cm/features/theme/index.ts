/**
 * Composer theme — the CSS-in-JS block that gives the composer its
 * look (font size, padding, scroller behaviour, selection colors,
 * vim fat-cursor, placeholder shade).
 *
 * `compact` shrinks the inner padding and zeroes the min-height for
 * surfaces that mount the composer inside a tight chip — the
 * user-message bubble's read-only render and inline-edit mode. The
 * standalone composer keeps the original generous numbers so the
 * one-line "type a message" affordance has visual breathing room.
 */

import type { Extension } from "@codemirror/state"
import { EditorView } from "@codemirror/view"

export function composerThemeFeature(opts: {
  compact: boolean
  readOnly?: boolean
}): Extension {
  const { compact, readOnly = false } = opts
  return EditorView.theme({
    "&": {
      fontSize: "14px",
      color: "inherit",
      backgroundColor: "transparent",
    },
    "&.cm-focused": { outline: "none" },
    ".cm-scroller": {
      fontFamily: "inherit",
      lineHeight: "1.5",
      maxHeight: "75vh",
      overflowY: "auto",
    },
    ".cm-content": {
      // Read-only (user-message bubble) and embedded (inline-edit on
      // a user-message bubble) both render inside a chip that
      // already provides visual padding, and a 74px min-height
      // makes one-line replies waste a ton of vertical space.
      // Shrink both for those cases; the standalone composer keeps
      // the original generous numbers.
      padding: compact ? "6px 10px" : "14px 20px",
      minHeight: compact ? "0" : "74px",
      caretColor: "currentColor",
      // Read-only renders inside a clickable user-message bubble.
      // CodeMirror's default `cursor: text` makes the bubble look
      // like a text field on hover; this is a native app and the
      // bubble is really a "click to edit" affordance, so fall
      // back to the OS arrow.
      ...(readOnly ? { cursor: "default" } : null),
    },
    ".cm-line": { padding: "0" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "currentColor" },
    // Use the OS's native selection color via CSS system color
    // keywords. `var(--accent)` is a near-background grey in both
    // light and dark themes, so the selection ends up invisible
    // (and outright unreadable on top of plugin themes like Hume's
    // purple). `Highlight` / `HighlightText` are the canonical
    // platform selection colors — they always match what the user
    // sees selecting text natively, and the OS guarantees the
    // pairing is legible.
    //
    // CodeMirror draws its own selection rect at line-height via
    // `.cm-selectionBackground`. If we also let the browser paint
    // `::selection` on top, the glyph-band ends up a slightly
    // different shade than the line-height rect and you get two
    // visible stripes. Hide the native paint inside the editor so
    // `.cm-selectionBackground` is the only selection layer.
    ".cm-selectionBackground": {
      backgroundColor: "Highlight !important",
    },
    "&.cm-focused .cm-selectionBackground": {
      backgroundColor: "Highlight !important",
    },
    "::selection": {
      backgroundColor: "transparent !important",
      color: "inherit !important",
    },
    ".cm-fat-cursor": {
      background: "var(--foreground) !important",
      color: "var(--background) !important",
    },
    "&:not(.cm-focused) .cm-fat-cursor": {
      background: "none !important",
      outline: "solid 1px var(--foreground)",
    },
    ".cm-placeholder": {
      color: "var(--muted-foreground)",
    },
  })
}
