import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ChangeEvent,
} from "react";
import { useDb, useDbClient, useRpc, View } from "@zenbujs/core/react";
import { Button } from "@zenbu/ui/button";
import { Input } from "@zenbu/ui/input";
import {
  NativeSelect,
  NativeSelectOption,
} from "@zenbu/ui/native-select";
import { Switch } from "@zenbu/ui/switch";
import { cn } from "@zenbu/ui/utils";
import { useWindowId } from "./shared/use-window-id";

/**
 * "Plugins" tab in the settings panel.
 *
 * Renders the generic plugin-contributed settings registry
 * (`root.settings.registry`):
 *
 *   - Left sidebar: one row per registered section, sorted by
 *     `order` then `label`. The active section is sticky via
 *     `root.settings.ui.lastPluginsSectionId`.
 *   - Right pane: items of the active section, grouped by
 *     `control.group`.
 *   - Top search box: substring match across `label`, `description`,
 *     `group`, `sectionLabel`, and `keywords` for every item in
 *     every section. When a search is active, items from across
 *     sections show up flat (with their section name as a chip),
 *     and the sidebar shows a per-section match count badge.
 *
 * Each control dispatches the registered RPC handler with
 * `{ windowId, value, ...args }` (or just `{ windowId, ...args }`
 * for buttons) using the same proxy-based dynamic-dispatch trick
 * the command palette uses. The handler is responsible for
 * applying the change and pushing the new value back into the
 * registry via `settingsRegistry.setValue`.
 */

// Mirror of the discriminated union in the schema. Kept loose to
// match the JSON shape that comes off the wire — a structural type
// is enough for the rendering switch below.
type ControlShape =
  | { kind: "toggle"; value: boolean }
  | {
      kind: "select";
      value: string;
      options: { value: string; label: string }[];
    }
  | {
      kind: "text";
      value: string;
      placeholder: string | null;
      multiline: boolean;
    }
  | {
      kind: "number";
      value: number;
      min: number | null;
      max: number | null;
      step: number | null;
    }
  | {
      kind: "button";
      buttonLabel: string;
      variant: "default" | "destructive";
    };

type Item = {
  id: string;
  sectionId: string;
  label: string;
  description: string | null;
  group: string | null;
  order: number;
  keywords: string[];
  control: ControlShape;
  rpc: { plugin: string; service: string; method: string };
  args: Record<string, unknown> | null;
};

type SectionBody =
  | { kind: "items" }
  | { kind: "view"; viewType: string };

type Section = {
  id: string;
  label: string;
  icon: string | null;
  order: number;
  body: SectionBody;
};

export function PluginsPanel() {
  const sections = useDb(
    (root) => root.settings.registry.sections,
  ) as Record<string, Section>;
  const items = useDb(
    (root) => root.settings.registry.items,
  ) as Record<string, Item>;
  const persistedSectionId = useDb(
    (root) => root.settings.ui.lastPluginsSectionId,
  );
  const dbClient = useDbClient();

  const orderedSections = useMemo(() => {
    return Object.values(sections).sort(
      (a, b) => a.order - b.order || a.label.localeCompare(b.label),
    );
  }, [sections]);

  const itemsBySection = useMemo(() => {
    const out = new Map<string, Item[]>();
    for (const item of Object.values(items)) {
      const arr = out.get(item.sectionId) ?? [];
      arr.push(item);
      out.set(item.sectionId, arr);
    }
    for (const arr of out.values()) {
      arr.sort(
        (a, b) =>
          a.order - b.order ||
          (a.group ?? "").localeCompare(b.group ?? "") ||
          a.label.localeCompare(b.label),
      );
    }
    return out;
  }, [items]);

  // Resolve the active section: persisted choice if it still
  // exists, otherwise the first section, otherwise null.
  const activeSectionId =
    (persistedSectionId &&
    orderedSections.some((s) => s.id === persistedSectionId)
      ? persistedSectionId
      : orderedSections[0]?.id) ?? null;

  const setActiveSection = useCallback(
    (id: string) => {
      void dbClient.update((root) => {
        root.settings.ui.lastPluginsSectionId = id;
      });
    },
    [dbClient],
  );

  const [query, setQuery] = useState("");

  const matchesQuery = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    const sectionLabel = (sectionId: string) =>
      sections[sectionId]?.label.toLowerCase() ?? "";
    return (item: Item): boolean => {
      const haystack = [
        item.label,
        item.description ?? "",
        item.group ?? "",
        sectionLabel(item.sectionId),
        ...item.keywords,
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    };
  }, [query, sections]);

  const matchCountBySection = useMemo(() => {
    if (!matchesQuery) return null;
    const counts = new Map<string, number>();
    for (const item of Object.values(items)) {
      if (!matchesQuery(item)) continue;
      counts.set(item.sectionId, (counts.get(item.sectionId) ?? 0) + 1);
    }
    return counts;
  }, [items, matchesQuery]);

  const flatSearchResults = useMemo(() => {
    if (!matchesQuery) return null;
    return Object.values(items)
      .filter(matchesQuery)
      .sort(
        (a, b) =>
          (sections[a.sectionId]?.order ?? 0) -
            (sections[b.sectionId]?.order ?? 0) ||
          a.sectionId.localeCompare(b.sectionId) ||
          a.label.localeCompare(b.label),
      );
  }, [items, matchesQuery, sections]);

  if (orderedSections.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-[12px] text-muted-foreground">
        <div className="text-[13px] font-medium text-foreground">
          No plugin settings yet
        </div>
        <p className="max-w-sm">
          Plugins can register their own settings by calling
          {" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">
            rpc.settings.settingsRegistry.registerItem
          </code>
          {" "}
          from a service. They'll appear here automatically.
        </p>
      </div>
    );
  }

  const activeSection = activeSectionId
    ? sections[activeSectionId] ?? null
    : null;
  const activeItems = activeSectionId
    ? itemsBySection.get(activeSectionId) ?? []
    : [];

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 pt-3">
      <Input
        autoFocus
        value={query}
        placeholder="Search all plugin settings…"
        onChange={(e: ChangeEvent<HTMLInputElement>) =>
          setQuery(e.target.value)
        }
        className="h-8 text-[12px]"
      />
      <div className="flex min-h-0 flex-1 gap-3 @max-[760px]:flex-col @max-[760px]:gap-2">
        <SectionsSidebar
          sections={orderedSections}
          activeSectionId={activeSectionId}
          onSelect={setActiveSection}
          matchCountBySection={matchCountBySection}
          itemsBySection={itemsBySection}
        />
        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          {flatSearchResults ? (
            <SearchResultsList
              items={flatSearchResults}
              sections={sections}
            />
          ) : activeSection ? (
            activeSection.body.kind === "view" ? (
              <View
                name={activeSection.body.viewType}
                args={{ sectionId: activeSection.id }}
                className="size-full"
                fallback={
                  <div className="pt-2 text-[12px] text-muted-foreground">
                    Loading…
                  </div>
                }
              />
            ) : (
              <SectionItems items={activeItems} />
            )
          ) : null}
        </div>
      </div>
    </div>
  );
}

function SectionsSidebar({
  sections,
  activeSectionId,
  onSelect,
  matchCountBySection,
  itemsBySection,
}: {
  sections: Section[];
  activeSectionId: string | null;
  onSelect: (id: string) => void;
  matchCountBySection: Map<string, number> | null;
  itemsBySection: Map<string, Item[]>;
}) {

  return (
    <nav className="flex w-[220px] shrink-0 flex-col gap-0.5 overflow-y-auto pr-1 @max-[760px]:w-full @max-[760px]:flex-row @max-[760px]:gap-1 @max-[760px]:overflow-x-auto @max-[760px]:overflow-y-hidden @max-[760px]:pr-0 @max-[760px]:pb-1">
      {sections.map((section) => {
        const isActive = section.id === activeSectionId;
        const matchCount = matchCountBySection?.get(section.id);
        return (
          <button
            key={section.id}
            type="button"
            onClick={() => onSelect(section.id)}
            className={cn(
              "flex items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] @max-[760px]:shrink-0",
              isActive
                ? "bg-accent text-accent-foreground"
                : "text-foreground hover:bg-accent/50",
            )}
          >
            {section.icon ? (
              <span
                aria-hidden
                className="flex size-4 shrink-0 items-center justify-center text-muted-foreground [&_svg]:size-4"
                dangerouslySetInnerHTML={{ __html: section.icon }}
              />
            ) : (
              <span
                aria-hidden
                className="flex size-4 shrink-0 items-center justify-center rounded bg-muted text-[10px] font-medium uppercase text-muted-foreground"
              >
                {section.label.slice(0, 1)}
              </span>
            )}
            <span className="min-w-0 flex-1 truncate font-medium">
              {section.label}
            </span>
            {matchCountBySection ? (
              matchCount ? (
                <span className="shrink-0 rounded-full bg-foreground/10 px-1.5 text-[10px] font-medium text-foreground">
                  {matchCount}
                </span>
              ) : (
                <span className="shrink-0 text-[10px] text-muted-foreground/60">
                  0
                </span>
              )
            ) : null}
          </button>
        );
      })}
    </nav>
  );
}

function SectionItems({ items }: { items: Item[] }) {
  if (items.length === 0) {
    return (
      <div className="pt-2 text-[12px] text-muted-foreground">
        This plugin hasn't registered any settings yet.
      </div>
    );
  }
  // Group by `control.group`. Items with no group land in an
  // implicit leading "" bucket rendered without a header.
  const groups = new Map<string, Item[]>();
  for (const item of items) {
    const g = item.group ?? "";
    const arr = groups.get(g) ?? [];
    arr.push(item);
    groups.set(g, arr);
  }
  return (
    <div className="flex flex-col gap-6">
      {[...groups.entries()].map(([group, rows]) => (
        <section key={group} className="flex flex-col gap-2">
          {group ? (
            <h2 className="text-[12px] font-semibold text-foreground">
              {group}
            </h2>
          ) : null}
          <div className="divide-y divide-border rounded-md border border-border">
            {rows.map((item) => (
              <ItemRow key={item.id} item={item} showSectionChip={false} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function SearchResultsList({
  items,
  sections,
}: {
  items: Item[];
  sections: Record<string, Section>;
}) {
  if (items.length === 0) {
    return (
      <div className="pt-2 text-[12px] text-muted-foreground">
        No settings match your search.
      </div>
    );
  }
  return (
    <div className="divide-y divide-border rounded-md border border-border">
      {items.map((item) => (
        <ItemRow
          key={item.id}
          item={item}
          showSectionChip
          sectionLabel={sections[item.sectionId]?.label ?? item.sectionId}
        />
      ))}
    </div>
  );
}

function ItemRow({
  item,
  showSectionChip,
  sectionLabel,
}: {
  item: Item;
  showSectionChip: boolean;
  sectionLabel?: string;
}) {
  const dispatch = useDispatchControl(item);
  return (
    <div className="flex items-start gap-4 p-3 @max-[480px]:flex-col @max-[480px]:items-stretch @max-[480px]:gap-2">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[13px] font-medium text-foreground">
            {item.label}
          </span>
          {showSectionChip && sectionLabel ? (
            <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
              {sectionLabel}
            </span>
          ) : null}
        </div>
        {item.description ? (
          <p className="mt-0.5 text-[12px] leading-snug text-muted-foreground">
            {item.description}
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center @max-[480px]:items-stretch">
        <ItemControl item={item} dispatch={dispatch} />
      </div>
    </div>
  );
}

function ItemControl({
  item,
  dispatch,
}: {
  item: Item;
  dispatch: (value: string | number | boolean | undefined) => void;
}) {
  const control = item.control;
  switch (control.kind) {
    case "toggle":
      return (
        <Switch
          checked={control.value}
          onCheckedChange={(checked: boolean) => dispatch(checked)}
        />
      );
    case "select":
      return (
        <NativeSelect
          value={control.value}
          onChange={(e: ChangeEvent<HTMLSelectElement>) =>
            dispatch(e.currentTarget.value)
          }
        >
          {control.options.map((option) => (
            <NativeSelectOption key={option.value} value={option.value}>
              {option.label}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      );
    case "text":
      return <TextItemControl control={control} dispatch={dispatch} />;
    case "number":
      return <NumberItemControl control={control} dispatch={dispatch} />;
    case "button":
      return (
        <Button
          size="sm"
          variant={control.variant === "destructive" ? "destructive" : "outline"}
          onClick={() => dispatch(undefined)}
        >
          {control.buttonLabel}
        </Button>
      );
  }
}

function TextItemControl({
  control,
  dispatch,
}: {
  control: Extract<ControlShape, { kind: "text" }>;
  dispatch: (value: string) => void;
}) {
  const [draft, setDraft] = useState(control.value);
  useEffect(() => {
    setDraft(control.value);
  }, [control.value]);
  return (
    <Input
      value={draft}
      placeholder={control.placeholder ?? undefined}
      onChange={(e: ChangeEvent<HTMLInputElement>) =>
        setDraft(e.target.value)
      }
      onBlur={() => {
        if (draft !== control.value) dispatch(draft);
      }}
      className="h-8 w-[220px] text-[12px]"
    />
  );
}

function NumberItemControl({
  control,
  dispatch,
}: {
  control: Extract<ControlShape, { kind: "number" }>;
  dispatch: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(control.value));
  useEffect(() => {
    setDraft(String(control.value));
  }, [control.value]);
  return (
    <input
      type="number"
      value={draft}
      min={control.min ?? undefined}
      max={control.max ?? undefined}
      step={control.step ?? undefined}
      onChange={(e: ChangeEvent<HTMLInputElement>) => setDraft(e.target.value)}
      onBlur={() => {
        const parsed = Number(draft);
        if (!Number.isFinite(parsed)) {
          setDraft(String(control.value));
          return;
        }
        if (parsed !== control.value) dispatch(parsed);
      }}
      className="h-8 w-[100px] rounded border border-border bg-background px-2 text-[12px] text-foreground"
    />
  );
}

/**
 * Builds a function that dispatches the item's registered RPC
 * with `{ windowId, value, ...args }`. Same proxy-erasure trick
 * the command palette uses — `rpc` is a JS Proxy that turns
 * bracket access into a path, so dynamic dispatch works without
 * the renderer knowing the shape of any individual plugin's API.
 */
function useDispatchControl(
  item: Item,
): (value: string | number | boolean | undefined) => void {
  const rpc = useRpc();
  const windowId = useWindowId();
  return useCallback(
    (value) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const router = rpc as any;
      const fn =
        router?.[item.rpc.plugin]?.[item.rpc.service]?.[item.rpc.method];
      if (typeof fn !== "function") {
        console.error(
          "[settings-registry] handler not found:",
          item.id,
          item.rpc,
        );
        return;
      }
      const payload: Record<string, unknown> = {
        windowId,
        ...(item.args ?? {}),
      };
      if (value !== undefined) payload.value = value;
      try {
        const maybePromise = fn(payload);
        if (maybePromise && typeof maybePromise.then === "function") {
          maybePromise.catch((err: unknown) => {
            console.error(
              "[settings-registry] dispatch rejected:",
              item.id,
              err,
            );
          });
        }
      } catch (err) {
        console.error(
          "[settings-registry] dispatch threw:",
          item.id,
          err,
        );
      }
    },
    [rpc, windowId, item],
  );
}
