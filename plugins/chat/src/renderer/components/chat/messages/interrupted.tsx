export function Interrupted() {
  return (
    <div className="flex items-center gap-3 px-3 py-2">
      <div className="h-px flex-1 bg-border" />
      <span className="select-none text-xs text-muted-foreground">
        Interrupted
      </span>
      <div className="h-px flex-1 bg-border" />
    </div>
  )
}
