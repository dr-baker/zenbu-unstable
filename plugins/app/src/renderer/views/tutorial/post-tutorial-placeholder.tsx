import { RotateCcw } from "lucide-react"

/** Quiet panel shown once the tutorial has exited. */
export function PostTutorialPlaceholder({
  onRedo,
}: {
  onRedo?: () => void
}) {
  return (
    <div className="flex h-full w-full items-center justify-center px-6 text-center">
      <div className="flex max-w-[360px] flex-col items-center gap-3 text-muted-foreground">
        <p className="text-[13px] text-foreground/85">Onboarding complete.</p>
        {onRedo ? (
          <button
            type="button"
            onClick={onRedo}
            className="inline-flex items-center gap-1.5 rounded-md border border-border/70 bg-background px-2.5 py-1 text-[12px] font-medium text-foreground/85 hover:border-border hover:bg-accent/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          >
            <RotateCcw className="h-[12px] w-[12px]" strokeWidth={1.75} />
            Redo onboarding
          </button>
        ) : null}
      </div>
    </div>
  )
}
