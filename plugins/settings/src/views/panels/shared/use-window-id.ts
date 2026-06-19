const DEFAULT_WINDOW_ID = "main";

/**
 * Window id of the surrounding host window. `WindowService.openView`
 * stamps `?windowId=<id>` into every iframe URL; legacy / test mounts
 * fall back to `"main"`. Component views run inside the host iframe
 * (no iframe of their own), but the URL convention is identical so
 * this works the same way.
 *
 * Inlined here instead of imported from the app plugin — the host
 * isn't a runtime dep of any other plugin.
 *
 * Read lazily on first use, not at module scope: the URL can't change
 * after load, but module-eval-time work in a view file runs inside
 * the injections prelude, where a throw disables every injection the
 * module registers. Keep import side effects at zero.
 */
let currentWindowId: string | null = null;

function readWindowIdFromUrl(): string {
  if (typeof window === "undefined") return DEFAULT_WINDOW_ID;
  const fromUrl = new URLSearchParams(window.location.search).get(
    "windowId",
  );
  return fromUrl && fromUrl.length > 0 ? fromUrl : DEFAULT_WINDOW_ID;
}

export function useWindowId(): string {
  if (currentWindowId === null) currentWindowId = readWindowIdFromUrl();
  return currentWindowId;
}
