import * as React from "react"
import { AlertCircle, CheckCircle2, Info, X } from "lucide-react"
import { cn } from "@/lib/utils"

export type ToastVariant = "default" | "success" | "destructive"

export interface ToastInput {
  title: string
  description?: string
  variant?: ToastVariant
  /** Optional inline action (e.g. Undo). Extends the toast duration. */
  action?: { label: string; onClick: () => void }
  /** Keep the toast up longer (used with actions). */
  duration?: number
}

interface ToastItem extends ToastInput {
  id: number
}

interface ToastContextValue {
  toast: (input: ToastInput) => void
}

const ToastContext = React.createContext<ToastContextValue | undefined>(undefined)

const ICONS: Record<ToastVariant, React.ComponentType<{ className?: string }>> = {
  default: Info,
  success: CheckCircle2,
  destructive: AlertCircle,
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = React.useState<ToastItem[]>([])
  const counter = React.useRef(0)
  const timers = React.useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map())

  const dismiss = React.useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
    const timer = timers.current.get(id)
    if (timer) {
      clearTimeout(timer)
      timers.current.delete(id)
    }
  }, [])

  const toast = React.useCallback(
    (input: ToastInput) => {
      const id = ++counter.current
      setToasts((prev) => [...prev.slice(-3), { ...input, id }])
      const duration = input.duration ?? (input.action ? 7000 : 4500)
      const timer = setTimeout(() => dismiss(id), duration)
      timers.current.set(id, timer)
    },
    [dismiss]
  )

  const value = React.useMemo(() => ({ toast }), [toast])

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 top-4 z-[100] flex flex-col items-center gap-2 px-4 sm:items-end sm:pr-6">
        {toasts.map((t) => {
          const Icon = ICONS[t.variant || "default"]
          return (
            <div
              key={t.id}
              role="status"
              className={cn(
                "pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-xl border border-border bg-popover p-4 shadow-lg",
                "animate-in slide-in-from-top-2 fade-in"
              )}
            >
              <Icon
                className={cn(
                  "mt-0.5 size-4 flex-shrink-0",
                  t.variant === "success" && "text-emerald-600 dark:text-emerald-400",
                  t.variant === "destructive" && "text-destructive",
                  (!t.variant || t.variant === "default") && "text-foreground/70"
                )}
              />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium leading-tight text-foreground">{t.title}</p>
                {t.description ? (
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">{t.description}</p>
                ) : null}
                {t.action ? (
                  <button
                    onClick={() => {
                      t.action?.onClick()
                      dismiss(t.id)
                    }}
                    className="mt-1.5 rounded-md px-1.5 py-0.5 text-xs font-medium text-primary underline-offset-2 transition-colors hover:bg-accent hover:underline"
                  >
                    {t.action.label}
                  </button>
                ) : null}
              </div>
              <button
                onClick={() => dismiss(t.id)}
                className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                aria-label="Dismiss"
              >
                <X className="size-3.5" />
              </button>
            </div>
          )
        })}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast(): ToastContextValue {
  const context = React.useContext(ToastContext)
  if (!context) throw new Error("useToast must be used within a ToastProvider")
  return context
}