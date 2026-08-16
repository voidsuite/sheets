import { cn } from "@/lib/utils"

interface VoidSheetsLogoProps {
  size?: "sm" | "md" | "lg"
  className?: string
  tagline?: boolean
}

const sizeConfig = {
  sm: { svg: "size-3.5", text: "text-sm", gap: "gap-1.5" },
  md: { svg: "size-4", text: "text-base", gap: "gap-2" },
  lg: { svg: "size-5", text: "text-lg", gap: "gap-2.5" },
}

/** voidsheets logo — a spreadsheet grid mark (one filled cell) + wordmark. */
export function VoidSheetsLogo({ size = "md", className, tagline = false }: VoidSheetsLogoProps) {
  const s = sizeConfig[size]
  return (
    <span className={cn("inline-flex items-center font-semibold tracking-tight", s.gap, className)}>
      <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className={s.svg}>
        <rect x="3.5" y="3.5" width="13" height="13" rx="1.8" stroke="currentColor" strokeWidth="1.6" />
        <path d="M8.2 3.5v13M13 3.5v13M3.5 8.2h13M3.5 12.9h13" stroke="currentColor" strokeWidth="1.1" opacity="0.55" />
        <rect x="8.2" y="3.5" width="4.8" height="4.7" fill="currentColor" />
      </svg>
      <span className={s.text}>
        voidsheets
        {tagline && (
          <span className="ml-1.5 hidden text-xs font-normal text-muted-foreground sm:inline">— Void Sheets</span>
        )}
      </span>
    </span>
  )
}