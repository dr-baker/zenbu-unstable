type ZenbuBootTrace = {
  mark(name: string): void;
};

declare global {
  interface Window {
    __zenbuBootTrace?: ZenbuBootTrace;
  }
}

// Boot-trace must mark before any other work; `__zenbuBootTrace` is
// installed by the iframe prelude that runs before this module evaluates.
window.__zenbuBootTrace?.mark("main-tsx-eval");

import { perfTrace } from "./lib/perf-trace";
perfTrace.install();

import { installDbReplicaTracer } from "./boot/db-replica-tracer";
installDbReplicaTracer();

import { createRoot } from "react-dom/client";
import { ZenbuProvider } from "@zenbujs/core/react";
import { App } from "./components/app";
import { IconFallback } from "./boot/icon-fallback";
import { markBoot } from "./boot/boot-trace";
import { installReactScanWhenRequested } from "./boot/react-scan";
import { initTheme } from "./lib/theme";
import { scan } from "react-scan";
// scan({ showToolbar: true, enabled: false });

// allotment's CSS is `@import`-ed from main.css so Tailwind only runs
// its compiler+scanner setup once for the entire entry instead of
// twice (once per CSS file id). On a cold boot that's ~650ms saved.
import "./main.css";

markBoot("main-tsx-imports-done");

initTheme();
markBoot("theme-initialized");

markBoot("before-create-root");
// Lazy-loading the app no longer serves a purpose: index.html paints the
// boot icon synchronously and we want App on screen ASAP. Skip the
// DeferredApp / dynamic import dance — the icon stays visible via
// IconFallback while ZenbuProvider connects, then App takes over.
const fallback = <IconFallback />;
createRoot(document.getElementById("root")!).render(
  <ZenbuProvider fallback={fallback}>
    <App />
  </ZenbuProvider>,
);
markBoot("after-render-call");
// 
// installReactScanWhenRequested();
