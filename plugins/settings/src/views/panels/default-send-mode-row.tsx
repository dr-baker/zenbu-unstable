import { useDb, useDbClient } from "@zenbujs/core/react";
import { ToggleGroup, ToggleGroupItem } from "@zenbu/ui/toggle-group";

type SendMode = "followUp" | "steer";

const OPTIONS: { value: SendMode; label: string; description: string }[] = [
  {
    value: "followUp",
    label: "Queue",
    description: "Queue after the current turn finishes",
  },
  {
    value: "steer",
    label: "Steer",
    description: "Interject before the agent's next LLM call",
  },
];

/**
 * Picks what plain `Enter` does in the composer while the agent is
 * streaming. Mod-Enter and the `/steer` / `/queue` slash commands
 * always force their own intent, regardless of this setting.
 *
 * Reads/writes `root.app.settings.defaultSendMode` via the typed
 * `dependsOn: app` surface — the actual config lives in the app
 * plugin's schema. This panel is just the UI for it.
 */
export function DefaultSendModeRow() {
  const dbClient = useDbClient();
  const mode = useDb((root) => root.app.settings.defaultSendMode) as SendMode;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between @max-[480px]:flex-wrap @max-[480px]:items-start">
        <span className="text-[12px] font-medium text-foreground">
          Default send mode
        </span>
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={mode}
          onValueChange={(value: string) => {
            if (!value) return;
            const next = value as SendMode;
            void dbClient.update((root) => {
              root.app.settings.defaultSendMode = next;
            });
          }}
        >
          {OPTIONS.map((option) => (
            <ToggleGroupItem
              key={option.value}
              value={option.value}
              className="text-[12px]"
            >
              {option.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>
      <span className="text-[11px] text-muted-foreground">
        {OPTIONS.find((o) => o.value === mode)?.description}. Applies when
        Enter is pressed while the agent is streaming.
      </span>
    </div>
  );
}
