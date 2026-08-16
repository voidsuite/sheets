/**
 * SheetPage — the spreadsheet workspace (/s/:id).
 *
 * Scaffold stage: hydrates the workbook from the gateway and shows the chrome
 * (name, role, vault state). The Univer grid, formula bar, tabs and toolbar
 * land in the next milestone.
 */

import { useEffect, useState } from "react"
import { Link, useParams } from "react-router"
import { ArrowLeft, FileSpreadsheet, Grid3x3, Loader2, Lock } from "lucide-react"
import { VoidSheetsLogo } from "@/components/VoidSheetsLogo"
import { useAuth } from "@/contexts/auth"
import * as api from "@/lib/api"
import type { HydratedSheet } from "@/lib/types"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"

function initials(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0]?.toUpperCase() ?? "")
      .join("") || "?"
  )
}

export function SheetPage() {
  const { id = "" } = useParams()
  const { user } = useAuth()
  const [data, setData] = useState<HydratedSheet | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    api
      .hydrateSheet(id)
      .then((d) => {
        if (!cancelled) setData(d)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load the sheet")
      })
    return () => {
      cancelled = true
    }
  }, [id])

  if (error) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 px-4">
        <div className="flex size-12 items-center justify-center rounded-2xl bg-destructive/10">
          <FileSpreadsheet className="size-6 text-destructive" aria-hidden="true" />
        </div>
        <p className="text-sm font-medium">Couldn't open this sheet</p>
        <p className="max-w-xs break-words text-center text-xs text-muted-foreground">{error}</p>
        <Button variant="outline" render={<Link to="/">Back to my sheets</Link>} />
      </div>
    )
  }

  return (
    <div className="flex h-screen flex-col">
      {/* Top bar */}
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-3">
        <Button variant="ghost" size="icon-sm" title="Back to my sheets" render={<Link to="/"><ArrowLeft className="size-4" /></Link>} />
        <Link to="/" className="hidden items-center sm:inline-flex">
          <VoidSheetsLogo size="sm" />
        </Link>
        <div className="h-5 w-px bg-border" aria-hidden="true" />
        <div className="flex min-w-0 items-center gap-2">
          {data ? (
            <>
              <p className="truncate text-sm font-medium">{data.sheet.name}</p>
              {data.sheet.vault && (
                <Badge variant="outline" className="gap-1 text-muted-foreground">
                  <Lock className="size-3" aria-hidden="true" /> Encrypted
                </Badge>
              )}
              <Badge variant="secondary" className="capitalize">
                {data.sheet.role}
              </Badge>
            </>
          ) : (
            <>
              <div className="h-4 w-28 animate-pulse rounded bg-muted" />
              <div className="h-4 w-10 animate-pulse rounded bg-muted" />
            </>
          )}
        </div>
        <div className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
          {data ? `${data.sheet.members.length} shared` : null}
          {user ? (
            <span className="flex size-7 items-center justify-center rounded-full bg-muted text-[10px] font-semibold text-muted-foreground" title={user.name}>
              {initials(user.name)}
            </span>
          ) : null}
        </div>
      </header>

      {/* Workspace — Univer grid replaces this in the next milestone */}
      <div className="flex flex-1 items-center justify-center overflow-hidden bg-muted/30">
        {data === null ? (
          <div className="flex flex-col items-center gap-3 text-muted-foreground">
            <Loader2 className="size-6 animate-spin" aria-label="Loading" />
            <p className="text-xs">Opening sheet…</p>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-3 text-center">
            <div className="flex size-14 items-center justify-center rounded-2xl bg-primary/10">
              <Grid3x3 className="size-7 text-primary" aria-hidden="true" />
            </div>
            <div>
              <p className="text-sm font-medium">The grid is coming next</p>
              <p className="mt-1 max-w-xs text-xs text-muted-foreground">
                {data.vault
                  ? "This sheet is end-to-end encrypted — it will open in the vault workspace."
                  : "Formulas, formatting, smart tabs and live collaboration are landing in the next milestone."}
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}