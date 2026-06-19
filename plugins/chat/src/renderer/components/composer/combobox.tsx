import { useState, type ReactNode } from "react"
import { CheckIcon, ChevronDownIcon } from "lucide-react"
import { Button } from "@zenbu/ui/button"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@zenbu/ui/command"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@zenbu/ui/popover"
import { cn } from "@/lib/utils"

export type ComboboxOption = {
  value: string
  name: string
  description?: string
  icon?: ReactNode
}

export type ComboboxProps = {
  label: string
  options: ComboboxOption[]
  currentValue: string | undefined
  onSelect: (value: string) => void
  align?: "start" | "end" | "center"
  className?: string
  /** Triggers a fallback placeholder when no option matches `currentValue`. */
  placeholder?: string
}

export function Combobox({
  label,
  options,
  currentValue,
  onSelect,
  align = "start",
  className,
  placeholder = label,
}: ComboboxProps) {
  const [open, setOpen] = useState(false)
  const selected = options.find(o => o.value === currentValue)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          role="combobox"
          aria-expanded={open}
          aria-label={label}
          className={cn(
            "group h-8 min-w-[7rem] max-w-[10rem] shrink-0 justify-between gap-1 rounded px-2.5 text-xs font-normal text-muted-foreground",
            className,
          )}
        >
          {selected?.icon}
          <span className="truncate">{selected?.name ?? placeholder}</span>
          <ChevronDownIcon
            className={cn(
              "size-3.5 shrink-0 opacity-0 transition-opacity group-hover:opacity-50 group-focus-visible:opacity-50",
              open && "opacity-50",
            )}
          />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[280px] p-0" align={align}>
        <Command>
          <CommandInput placeholder={`Search ${label.toLowerCase()}…`} />
          <CommandList>
            <CommandEmpty>No match.</CommandEmpty>
            <CommandGroup>
              {options.map(opt => (
                <CommandItem
                  key={opt.value}
                  value={`${opt.name} ${opt.description ?? ""} ${opt.value}`}
                  onSelect={() => {
                    onSelect(opt.value)
                    setOpen(false)
                  }}
                  className="flex flex-col items-start gap-0.5 py-2"
                >
                  <span className="flex w-full items-center gap-2">
                    {opt.icon}
                    <span className="flex-1 truncate text-sm">{opt.name}</span>
                    <CheckIcon
                      className={cn(
                        "size-4 shrink-0",
                        currentValue === opt.value
                          ? "opacity-100"
                          : "opacity-0",
                      )}
                    />
                  </span>
                  {opt.description && (
                    <span className="line-clamp-2 w-full text-left text-xs text-muted-foreground">
                      {opt.description}
                    </span>
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
