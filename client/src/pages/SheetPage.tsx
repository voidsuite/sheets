/**
 * SheetPage — the spreadsheet workspace (/s/:id).
 *
 * Hydrates the VS1 doc from the gateway, boots the Univer engine into a
 * container, and layers the VoidSheets chrome (toolbar, share, rename,
 * status) around it. Collaboration, export, versions and the vault flow land
 * in the next milestones; this page is where they'll plug in.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { Link, useParams } from "react-router"
import {
  ArrowLeft,
  Eye,
  FileSpreadsheet,
  Grid3x3,
  Loader2,
  Lock,
  MoreHorizontal,
  Pencil,
  Redo2,
  Share2,
  Undo2,
} from "lucide-react"
import { VoidSheetsLogo } from "@/components/VoidSheetsLogo"
import { ShareDialog } from "@/components/share-dialog"
import { useAuth } from "@/contexts/auth"
import { SheetProvider, useSheet } from "@/contexts/univer"
import { useToast } from "@/contexts/toast"
import { useSettings } from "@/contexts/settings"
import * as api from "@/lib/api"
import { createUniverRuntime } from "@/lib/univer-factory"
import type { UniverRuntime } from "@/lib/univer-factory"
import type { HydratedSheet, VDoc } from "@/lib/types"
import { vs1ToSnapshot } from "@/lib/workbook"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"

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

/** Live presence: online member avatars + connection status dot. */
function PresenceChrome() {
  const { collab, collabPresence, collabStatus } = useSheet()
  if (!collab) return null
  const dot: Record<typeof collabStatus, string> = {
    online: "bg-emerald-500",
    connecting: "bg-amber-400 animate-pulse",
    offline: "bg-zinc-500",
    error: "bg-red-500",
  }
  const shown = collabPresence.slice(0, 4)
  const extra = Math.max(0, collabPresence.length - shown.length)
  return (
    <div className="flex items-center gap-2">
      <span className="flex items-center -space-x-1.5" title={`${collabPresence.length} online`}>
        {shown.map((m) => (
          <span
            key={m.userId}
            className="flex size-6 items-center justify-center rounded-full bg-muted text-[10px] font-semibold text-muted-foreground ring-2 ring-background"
            title={m.name}
          >
            {initials(m.name)}
          </span>
        ))}
        {extra > 0 ? (
          <span className="flex size-6 items-center justify-center rounded-full bg-primary/10 text-[10px] font-medium text-primary ring-2 ring-background">
            +{extra}
          </span>
        ) : null}
      </span>
      <span className={`size-2 shrink-0 rounded-full ${dot[collabStatus]}`} title={`Connection: ${collabStatus}`} />
    </div>
  )
}

export function SheetPage() {
  const { id = "" } = useParams()
  const { user } = useAuth()
  const { toast } = useToast()
  const { theme } = useSettings()

  const containerRef = useRef<HTMLDivElement>(null)
  const [data, setData] = useState<HydratedSheet | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [runtime, setRuntime] = useState<UniverRuntime | null>(null)
  const [doc, setDoc] = useState<VDoc | null>(null)
  const [booted, setBooted] = useState(false)

  const [renaming, setRenaming] = useState(false)
  const [renameName, setRenameName] = useState("")
  const [shareOpen, setShareOpen] = useState(false)

  // Hydrate the workbook.
  useEffect(() => {
    let cancelled = false
    setData(null)
    setError(null)
    setBooted(false)
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

  // Boot the Univer engine once we have the doc (non-vaulted sheets).
  const dark =
    theme === "dark" || (theme === "system" && window.matchMedia?.("(prefers-color-scheme: dark)").matches)

  useEffect(() => {
    if (!data || data.vault || !data.doc || !containerRef.current) return
    const rt = createUniverRuntime(containerRef.current)
    setRuntime(rt)
    const snapshot = vs1ToSnapshot(data.doc, data.sheet.id)
    rt.univerAPI.createWorkbook(snapshot, { makeCurrent: true })
    setDoc(data.doc)
    setBooted(true)
    return () => {
      rt.dispose()
      setRuntime(null)
      setDoc(null)
      setBooted(false)
    }
  }, [data])

  // Keep the grid theme in sync with the app theme.
  useEffect(() => {
    document.documentElement.dataset.univerDark = dark ? "1" : "0"
  }, [dark])

  const rename = useCallback(async () => {
    const name = renameName.trim()
    if (!name || !data) return
    try {
      const wb = await api.renameWorkbook(data.sheet.id, name)
      setData((prev) => (prev ? { ...prev, sheet: wb } : prev))
      setRenaming(false)
      toast({ title: "Renamed", description: name })
    } catch (err) {
      toast({ title: "Couldn't rename", description: err instanceof Error ? err.message : undefined, variant: "destructive" })
    }
  }, [renameName, data, toast])

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

  const wb = data?.sheet ?? null
  const editable = wb ? wb.role === "owner" || wb.role === "editor" : false

  return (
    <SheetProvider runtime={runtime} wb={wb} doc={doc} version={data?.version ?? 0} user={user}>
      <div className="flex h-screen flex-col bg-background">
      {/* Top bar */}
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-2.5">
        <Button variant="ghost" size="icon-sm" title="Back to my sheets" render={<Link to="/"><ArrowLeft className="size-4" /></Link>} />
        <Link to="/" className="hidden items-center md:inline-flex">
          <VoidSheetsLogo size="sm" />
        </Link>
        <div className="h-5 w-px bg-border" aria-hidden="true" />

        <div className="flex min-w-0 items-center gap-2">
          {wb ? (
            <>
              <button
                className="max-w-48 truncate text-sm font-medium hover:underline"
                title="Rename"
                onClick={() => {
                  setRenameName(wb.name)
                  setRenaming(true)
                }}
                disabled={!editable}
              >
                {wb.name}
              </button>
              {wb.vault && (
                <Badge variant="outline" className="gap-1 text-muted-foreground">
                  <Lock className="size-3" aria-hidden="true" /> Encrypted
                </Badge>
              )}
              <Badge variant="secondary" className="capitalize">
                {wb.role}
              </Badge>
            </>
          ) : (
            <div className="h-4 w-28 animate-pulse rounded bg-muted" />
          )}
        </div>

        <div className="ml-auto flex items-center gap-1">
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button variant="ghost" size="icon-sm" onClick={() => void runtime?.univerAPI.undo()} disabled={!editable || !runtime} aria-label="Undo">
                    <Undo2 className="size-4" />
                  </Button>
                }
              />
              <TooltipContent>Undo</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button variant="ghost" size="icon-sm" onClick={() => void runtime?.univerAPI.redo()} disabled={!editable || !runtime} aria-label="Redo">
                    <Redo2 className="size-4" />
                  </Button>
                }
              />
              <TooltipContent>Redo</TooltipContent>
            </Tooltip>
          </TooltipProvider>

          <Button variant="ghost" size="sm" className="gap-1.5" onClick={() => setShareOpen(true)} disabled={!wb}>
            <Share2 className="size-3.5" /> Share
          </Button>

          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button variant="ghost" size="icon-sm" aria-label="Sheet menu">
                  <MoreHorizontal className="size-4" />
                </Button>
              }
            />
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuLabel>Coming in the next milestones</DropdownMenuLabel>
              <DropdownMenuItem disabled>
                <Pencil className="size-3.5" /> Import / export
              </DropdownMenuItem>
              <DropdownMenuItem disabled>
                <Grid3x3 className="size-3.5" /> Version history
              </DropdownMenuItem>
              <DropdownMenuItem disabled>
                <Lock className="size-3.5" /> Vault (end-to-end encryption)
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem disabled>
                <FileSpreadsheet className="size-3.5" /> Templates
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <PresenceChrome />

          {user ? (
            <span
              className="ml-1 flex size-7 items-center justify-center rounded-full bg-muted text-[10px] font-semibold text-muted-foreground"
              title={user.name}
            >
              {initials(user.name)}
            </span>
          ) : null}
        </div>
      </header>

      {/* Read-only banner for viewers */}
      {wb && !editable ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-border bg-muted/40 px-4 py-1.5 text-xs text-muted-foreground">
          <Eye className="size-3.5 shrink-0" aria-hidden="true" />
          <span>
            View-only — you can watch changes as editors make them, but edits are saved by the owner and editors.
          </span>
        </div>
      ) : null}

      {/* Grid */}
      <div className="relative min-h-0 flex-1">
        <div ref={containerRef} className="h-full w-full overflow-hidden" />
        {(!booted || !data) && !data?.vault ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background text-muted-foreground">
            <Loader2 className="size-6 animate-spin" aria-label="Loading" />
            <p className="text-xs">{data ? "Rendering grid…" : "Opening sheet…"}</p>
          </div>
        ) : null}
      </div>

      {data?.vault ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
          <div className="flex size-14 items-center justify-center rounded-2xl bg-primary/10">
            <Lock className="size-7 text-primary" aria-hidden="true" />
          </div>
          <div>
            <p className="text-sm font-medium">Encrypted sheet</p>
            <p className="mt-1 max-w-xs text-xs text-muted-foreground">
              This sheet is end-to-end encrypted. The vault workspace — unlock with your device key — is landing in the next
              milestone.
            </p>
          </div>
        </div>
      ) : null}

      <RenamesDialog
        open={renaming}
        value={renameName}
        onChange={setRenameName}
        onCancel={() => setRenaming(false)}
        onSubmit={() => void rename()}
      />
      <ShareDialog open={shareOpen} onOpenChange={setShareOpen} wb={wb} onChanged={(next) => setData((prev) => (prev ? { ...prev, sheet: next } : prev))} />
      </div>
    </SheetProvider>
  )
}

function RenamesDialog({
  open,
  value,
  onChange,
  onCancel,
  onSubmit,
}: {
  open: boolean
  value: string
  onChange: (v: string) => void
  onCancel: () => void
  onSubmit: () => void
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Rename sheet</DialogTitle>
          <DialogDescription>Changes are saved to everyone who has access.</DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            onSubmit()
          }}
        >
          <Input autoFocus value={value} onChange={(e) => onChange(e.target.value)} maxLength={120} />
          <DialogFooter className="mt-5">
            <DialogClose render={<Button type="button" variant="outline">Cancel</Button>} />
            <Button type="submit" disabled={!value.trim()}>
              Rename
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}