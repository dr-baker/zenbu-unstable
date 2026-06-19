import { Button } from "@zenbu/ui/button"
import { cn } from "@/lib/utils"
import type { PermissionRequestProps } from "../message-components"

export function PermissionRequest({
  title,
  description,
  options,
  responded,
  onSelect,
}: PermissionRequestProps) {
  return (
    <div className="px-3 py-1">
      <div className="w-full overflow-hidden rounded border border-border bg-card text-card-foreground">
        <div className="px-3 py-2.5">
          <div className="mb-1.5 flex items-center gap-2">
            <span className="truncate text-sm font-medium text-foreground">
              {title}
            </span>
            <span className="ml-auto text-sm text-muted-foreground">
              {responded ? "Resolved" : "Waiting"}
            </span>
          </div>
          {description && (
            <p className="mb-3 text-sm leading-relaxed text-muted-foreground">
              {description}
            </p>
          )}
          {!responded && (
            <div className="flex w-full flex-col gap-1.5">
              {options.map(option => (
                <Button
                  key={option.optionId}
                  type="button"
                  variant="outline"
                  onClick={() => onSelect(option.optionId)}
                  className={cn(
                    "h-auto w-full justify-start rounded bg-card px-3 py-1.5 text-left text-sm font-medium",
                    option.kind.startsWith("reject")
                      ? "text-red-500"
                      : "text-foreground",
                  )}
                >
                  {option.name}
                </Button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
