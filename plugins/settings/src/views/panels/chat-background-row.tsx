import { useCallback, useEffect, useRef, useState } from "react";
import { useDb, useDbClient } from "@zenbujs/core/react";
import { Button } from "@zenbu/ui/button";
import { Slider } from "@zenbu/ui/slider";

const ACCEPT =
  "image/png,image/jpeg,image/gif,image/webp,image/svg+xml,image/avif";

const DEFAULT_BG_OPACITY = 0.15;

type ChatBackgroundSetting = {
  blobId: string;
  mimeType: string;
  opacity: number;
} | null;

/**
 * Resolve the blob bytes for the current chat background into an
 * object URL. Inlined from the host's `useChatBackgroundUrl` — pure
 * `useDbClient().getBlobData` + `URL.createObjectURL`, nothing the
 * plugin can't do itself.
 */
function useChatBackgroundUrl(background: ChatBackgroundSetting): string | null {
  const client = useDbClient();
  const [url, setUrl] = useState<string | null>(null);
  const blobId = background?.blobId ?? null;
  const mimeType = background?.mimeType ?? "image/png";

  useEffect(() => {
    if (!blobId) {
      setUrl(null);
      return;
    }
    let revoke: string | null = null;
    let cancelled = false;
    void (async () => {
      try {
        const data = await client.getBlobData(blobId);
        if (cancelled || !data) return;
        const blob = new Blob([data as BlobPart], { type: mimeType });
        revoke = URL.createObjectURL(blob);
        setUrl(revoke);
      } catch (err) {
        console.error("[chat-background] failed to load blob:", err);
      }
    })();
    return () => {
      cancelled = true;
      if (revoke) URL.revokeObjectURL(revoke);
      setUrl(null);
    };
  }, [client, blobId, mimeType]);

  return url;
}

/**
 * Lets the user upload / clear an image rendered behind the chat
 * surface and tweak its opacity. The background setting lives on
 * the app plugin (`root.app.settings.chatBackground`) since the
 * chat itself is owned by app — this panel is just the UI for it.
 */
export function ChatBackgroundRow() {
  const dbClient = useDbClient();
  const background = useDb(
    (root) => root.app.settings.chatBackground,
  ) as ChatBackgroundSetting;
  const url = useChatBackgroundUrl(background);
  const inputRef = useRef<HTMLInputElement>(null);

  const setBackground = useCallback(
    async (next: ChatBackgroundSetting) => {
      const prev = dbClient.readRoot().app.settings.chatBackground;
      await dbClient.update((root) => {
        root.app.settings.chatBackground = next;
      });
      if (!next && prev?.blobId) {
        try {
          await dbClient.deleteBlob(prev.blobId);
        } catch (err) {
          console.error("[chat-background] deleteBlob failed:", err);
        }
      }
    },
    [dbClient],
  );

  const uploadBackground = useCallback(
    async (file: File, opacity: number) => {
      const data = new Uint8Array(await file.arrayBuffer());
      const prev = dbClient.readRoot().app.settings.chatBackground;
      const blobId = await dbClient.createBlob(data, true);
      await dbClient.update((root) => {
        root.app.settings.chatBackground = {
          blobId,
          mimeType: file.type || "image/png",
          opacity,
        };
      });
      if (prev?.blobId) {
        try {
          await dbClient.deleteBlob(prev.blobId);
        } catch (err) {
          console.error(
            "[chat-background] deleteBlob (replace) failed:",
            err,
          );
        }
      }
    },
    [dbClient],
  );

  const onPick = () => inputRef.current?.click();

  const onFile = async (file: File) => {
    const opacity = background?.opacity ?? DEFAULT_BG_OPACITY;
    await uploadBackground(file, opacity);
  };

  const onOpacity = async (opacity: number) => {
    if (!background) return;
    await setBackground({ ...background, opacity });
  };

  const onClear = async () => {
    await setBackground(null);
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between @max-[480px]:flex-wrap @max-[480px]:items-start">
        <span className="text-[12px] font-medium text-foreground">
          Chat background
        </span>
        <div className="flex items-center gap-2">
          {background && (
            <Button size="sm" variant="ghost" onClick={onClear}>
              Clear
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={onPick}>
            {background ? "Replace" : "Upload"}
          </Button>
        </div>
      </div>

      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (!file) return;
          onFile(file).catch((err) =>
            console.error("[chat-background] upload failed:", err),
          );
        }}
      />

      {background && (
        <>
          <BackgroundPreview url={url} opacity={background.opacity} />
          <OpacitySlider
            value={background.opacity}
            onChange={(value) => {
              void onOpacity(value);
            }}
          />
        </>
      )}
    </div>
  );
}

function BackgroundPreview({
  url,
  opacity,
}: {
  url: string | null;
  opacity: number;
}) {
  return (
    <div
      className="relative h-24 w-full overflow-hidden rounded border border-border bg-card"
      style={{
        backgroundImage:
          "linear-gradient(45deg, rgba(0,0,0,0.04) 25%, transparent 25%, transparent 75%, rgba(0,0,0,0.04) 75%), linear-gradient(45deg, rgba(0,0,0,0.04) 25%, transparent 25%, transparent 75%, rgba(0,0,0,0.04) 75%)",
        backgroundSize: "12px 12px",
        backgroundPosition: "0 0, 6px 6px",
      }}
    >
      {url ? (
        <img
          src={url}
          alt="Chat background preview"
          className="absolute inset-0 h-full w-full object-cover"
          style={{ opacity }}
        />
      ) : (
        <div className="flex h-full items-center justify-center text-[11px] text-muted-foreground">
          Loading…
        </div>
      )}
    </div>
  );
}

function OpacitySlider({
  value,
  onChange,
}: {
  value: number;
  onChange: (next: number) => void;
}) {
  return (
    <div className="flex items-center gap-3">
      <span className="text-[12px] text-muted-foreground">Opacity</span>
      <Slider
        min={0}
        max={1}
        step={0.01}
        value={[value]}
        onValueChange={(values: number[]) => onChange(values[0] ?? value)}
        className="flex-1"
      />
      <span className="w-10 text-right font-mono text-[11px] text-muted-foreground">
        {(value * 100).toFixed(0)}%
      </span>
    </div>
  );
}
