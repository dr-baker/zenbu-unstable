import {
  useDb,
  useRpc,
  type ViewComponentProps,
} from "@zenbujs/core/react";
import { StatusBarItem } from "../components/status-bar-item";

export type ChatStatsArgs = {
  /** The session whose stats to render. Pass explicitly so a
   * footer embedded inside one pane shows *that* pane's session —
   * not whichever session happens to be focused window-wide. */
  sessionId?: string | null;
};

/**
 * A 12px circular gauge that fills proportionally to `percent`.
 * Replaces lucide's static `GaugeIcon` — at this size a needle is
 * illegible, but a ring that visibly fills as the context window
 * fills gives you the same at-a-glance read as e.g. a battery
 * indicator. `currentColor` is inherited from the parent
 * `StatusBarItem` so the tone (default / warning / danger) still
 * controls the color.
 */
function ContextGauge({ percent }: { percent: number }) {
  const radius = 4.5;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.max(0, Math.min(100, percent));
  const offset = circumference - (clamped / 100) * circumference;
  return (
    <svg
      className="size-3"
      viewBox="0 0 12 12"
      fill="none"
      aria-hidden="true"
    >
      <circle
        cx="6"
        cy="6"
        r={radius}
        stroke="currentColor"
        strokeOpacity="0.25"
        strokeWidth="1.5"
      />
      <circle
        cx="6"
        cy="6"
        r={radius}
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        transform="rotate(-90 6 6)"
      />
    </svg>
  );
}

/**
 * Format token counts the same way pi's footer does
 * (modes/interactive/components/footer.js#formatTokens).
 */
function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

/**
 * Session stats line. We deliberately keep this small — just the
 * two numbers users actually steer by (context window usage +
 * the running cost). The full in/out/cache breakdown lived here
 * once but it crowded out more useful info (cwd, branch, extra
 * dirs) and the granular numbers are already available in the
 * per-turn summary cards.
 *
 * Model / thinking level live in the composer toolbar above,
 * not here.
 *
 * Registered by `PiFooterViewsService` as `pi-footer.chat-stats`
 * with `meta.position = "left", order = 20`.
 */
export default function ChatStatsItem({
  args,
}: ViewComponentProps<ChatStatsArgs>) {
  const sessionId = args?.sessionId ?? null;
  const stats = useDb((root) => {
    if (!sessionId) return null;
    return root.pi.sessions[sessionId]?.stats ?? null;
  });

  if (!stats) return null;

  const { cost, contextUsage, autoCompactionEnabled } = stats;

  let contextTone: "default" | "warning" | "danger" = "default";
  let contextLabel: string | null = null;
  if (contextUsage) {
    const cw = formatTokens(contextUsage.contextWindow);
    if (contextUsage.percent === null) {
      contextLabel = `?% of ${cw}`;
    } else {
      contextLabel = `${contextUsage.percent.toFixed(0)}% of ${cw}`;
      if (contextUsage.percent > 90) contextTone = "danger";
      else if (contextUsage.percent > 70) contextTone = "warning";
    }
  }

  if (!contextLabel && !cost) return null;

  return (
    <>
      {contextLabel && contextUsage && (
        <StatusBarItem
          icon={<ContextGauge percent={contextUsage.percent ?? 0} />}
          tone={contextTone}
          title={
            `Context window usage: ` +
            `${contextUsage.tokens?.toLocaleString() ?? "?"} of ` +
            `${contextUsage.contextWindow.toLocaleString()} tokens`
          }
        >
          {contextLabel}
        </StatusBarItem>
      )}
      {contextUsage && sessionId && (
        <AutoCompactionStatusItem
          sessionId={sessionId}
          enabled={autoCompactionEnabled}
        />
      )}
      {!!cost && (
        <StatusBarItem
          title={`Estimated cost so far: $${cost.toFixed(4)}`}
        >
          ${cost.toFixed(3)}
        </StatusBarItem>
      )}
    </>
  );
}

/**
 * Click-to-toggle pill for pi's auto-compaction setting. When on,
 * pi summarizes older turns as the context window fills up; when
 * off, the session runs into the model's hard limit. The label is
 * spelled out ("auto-compact: on/off") instead of the previous
 * bare "auto" tag so it's obvious what's being toggled without
 * having to read the tooltip.
 */
function AutoCompactionStatusItem({
  sessionId,
  enabled,
}: {
  sessionId: string;
  enabled: boolean;
}) {
  const rpc = useRpc();
  return (
    <StatusBarItem
      onClick={() => {
        void rpc.pi.sessions.setAutoCompactionEnabled({
          sessionId,
          enabled: !enabled,
        });
      }}
      title={
        enabled
          ? "Auto-compaction is on — pi will summarize older turns as the context window fills up.\nClick to turn off."
          : "Auto-compaction is off — the session will run into the model's context limit instead of summarizing.\nClick to turn on."
      }
    >
      <span>auto-compact: {enabled ? "on" : "off"}</span>
    </StatusBarItem>
  );
}
