/**
 * HomePage — the flat "My sheets" file list.
 *
 * Recent + everything you own or are shared into, in one grid. Each card
 * opens the sheet page; owners can rename/delete; the header shows who you
 * are and lets you sign out.
 */

import { useCallback, useEffect, useMemo, useState } from "react"
import { useNavigate } from "react-router"
import { FileSpreadsheet, Loader2, Lock, MoreHorizontal, Pencil, Plus, Search, Trash2 } from "lucide-react"
import { VoidSheetsLogo } from "@/components/VoidSheetsLogo"
import { useAuth } from "@/contexts/auth"
import { useToast } from "@/contexts/toast"
import * as api from "@/lib/api"
import type { Workbook } from "@/lib/types"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
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
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"

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

function timeAgo(ts: number): string {
  const diff = Date.now() - ts
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

function WorkbookCard({
  wb,
  onRename,
  onDelete,
  onOpen,
}: {
  wb: Workbook
  onRename: (wb: Workbook) => void
  onDelete: (wb: Workbook) => void
  onOpen: (id: string) => void
}) {
  const canDelete = wb.role === "owner"
  return (
    <button
      onClick={() => onOpen(wb.id)}
      className="group flex h-full flex-col items-start gap-3 rounded-xl border border-border bg-card p-4 text-left transition-colors hover:border-foreground/25 hover:bg-accent/40"
    >
      <div className="flex w-full items-start justify-between">
        <div className="flex size-10 items-center justify-center rounded-lg bg-primary/10">
          <FileSpreadsheet className="size-5 text-primary" aria-hidden="true" />
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                className="size-7 rounded-md text-muted-foreground opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
                aria-label={`Actions for ${wb.name}`}
                onClick={(e: React.MouseEvent) => e.stopPropagation()}
              >
                <MoreHorizontal className="size-4" />
              </Button>
            }
          />
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => onRename(wb)} disabled={wb.role === "viewer"}>
              <Pencil className="size-3.5" /> Rename
            </DropdownMenuItem>
            {canDelete && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={() => onDelete(wb)}>
                  <Trash2 className="size-3.5" /> Delete
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="min-w-0 flex-1 space-y-1.5">
        <p className="truncate text-sm font-medium" title={wb.name}>
          {wb.name}
        </p>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span>Edited {timeAgo(wb.updatedAt)}</span>
          <span aria-hidden="true">·</span>
          {wb.vault ? (
            <span className="inline-flex items-center gap-1">
              <Lock className="size-3" aria-hidden="true" /> Encrypted
            </span>
          ) : (
            <span className="inline-flex items-center gap-1">
              <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-muted text-[9px] font-semibold text-muted-foreground">
                {initials(wb.owner.name)}
              </span>
              {wb.owner.name}
            </span>
          )}
        </div>
      </div>

      <div className="flex w-full items-center justify-between gap-2">
        <Badge variant="secondary" className="capitalize">
          {wb.role}
        </Badge>
        {wb.members.length > 0 && !wb.vault && (
          <span className="text-xs text-muted-foreground">{wb.members.length} shared</span>
        )}
      </div>
    </button>
  )
}

export function HomePage() {
  const { user, signOut } = useAuth()
  const { toast } = useToast()
  const navigate = useNavigate()

  const [workbooks, setWorkbooks] = useState<Workbook[] | null>(null)
  const [query, setQuery] = useState("")
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState("")
  const [createOpen, setCreateOpen] = useState(false)
  const [renaming, setRenaming] = useState<Workbook | null>(null)
  const [renameName, setRenameName] = useState("")
  const [deleting, setDeleting] = useState<Workbook | null>(null)

  const load = useCallback(() => {
    api
      .listWorkbooks()
      .then(setWorkbooks)
      .catch(() => {
        setWorkbooks([])
        toast({ title: "Couldn't load your sheets", variant: "destructive" })
      })
  }, [toast])

  useEffect(() => {
    load()
  }, [load])

  const filtered = useMemo(() => {
    if (!workbooks) return null
    const q = query.trim().toLowerCase()
    if (!q) return workbooks
    return workbooks.filter((w) => w.name.toLowerCase().includes(q))
  }, [workbooks, query])

  const create = useCallback(async () => {
    const name = newName.trim()
    if (!name) return
    setCreating(true)
    try {
      const wb = await api.createWorkbook({ name })
      setCreateOpen(false)
      setNewName("")
      toast({ title: "Sheet created", description: name })
      navigate(`/s/${wb.id}`)
    } catch (err) {
      toast({ title: "Couldn't create the sheet", description: err instanceof Error ? err.message : undefined, variant: "destructive" })
    } finally {
      setCreating(false)
    }
  }, [newName, navigate, toast])

  const rename = useCallback(async () => {
    if (!renaming) return
    const name = renameName.trim()
    if (!name) return
    try {
      await api.renameWorkbook(renaming.id, name)
      setRenaming(null)
      toast({ title: "Renamed", description: name })
      load()
    } catch (err) {
      toast({ title: "Couldn't rename", description: err instanceof Error ? err.message : undefined, variant: "destructive" })
    }
  }, [renaming, renameName, load, toast])

  const remove = useCallback(async () => {
    if (!deleting) return
    try {
      await api.deleteWorkbook(deleting.id)
      setDeleting(null)
      toast({ title: "Deleted", description: deleting.name })
      load()
    } catch {
      toast({ title: "Couldn't delete", variant: "destructive" })
    }
  }, [deleting, load, toast])

  return (
    <div className="flex min-h-screen flex-col">
      {/* Header */}
      <header className="sticky top-0 z-10 border-b border-border bg-background/80 backdrop-blur">
        <div className="mx-auto flex h-14 w-full max-w-6xl items-center gap-4 px-4">
          <VoidSheetsLogo size="md" tagline />
          <div className="relative ml-2 hidden w-full max-w-xs sm:block">
            <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search sheets…"
              className="h-8 pl-8 text-sm"
            />
          </div>
          <div className="ml-auto flex items-center gap-3">
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <Plus className="size-4" /> New sheet
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <button className="flex size-8 items-center justify-center rounded-full" aria-label="Account menu">
                    <Avatar className="size-8">
                      {user?.picture ? <AvatarImage src={user.picture} alt={user?.name ?? ""} /> : null}
                      <AvatarFallback>{initials(user?.name ?? "?")}</AvatarFallback>
                    </Avatar>
                  </button>
                }
              />
              <DropdownMenuContent align="end" className="w-52">
                <div className="px-2 py-1.5">
                  <p className="truncate text-sm font-medium">{user?.name}</p>
                  <p className="truncate text-xs text-muted-foreground">{user?.email}</p>
                </div>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => void signOut()}>Sign out</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8">
        <div className="mb-6 flex items-end justify-between">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">My sheets</h1>
            <p className="mt-0.5 text-sm text-muted-foreground">Everything you own or have been shared into.</p>
          </div>
        </div>

        {filtered === null ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-40 rounded-xl" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border py-20 text-center">
            <div className="flex size-12 items-center justify-center rounded-2xl bg-primary/10">
              <FileSpreadsheet className="size-6 text-primary" aria-hidden="true" />
            </div>
            <p className="mt-4 text-sm font-medium">{query ? "No sheets match your search" : "No sheets yet"}</p>
            <p className="mt-1 max-w-xs text-xs text-muted-foreground">
              {query
                ? "Try a different search, or create a new sheet."
                : "Create your first spreadsheet — formulas, formatting and sharing included."}
            </p>
            {!query && (
              <Button className="mt-5" onClick={() => setCreateOpen(true)}>
                <Plus className="size-4" /> New sheet
              </Button>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            <button
              onClick={() => setCreateOpen(true)}
              className="flex h-40 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border text-muted-foreground transition-colors hover:border-primary/50 hover:text-primary"
            >
              <Plus className="size-5" aria-hidden="true" />
              <span className="text-sm font-medium">New sheet</span>
            </button>
            {filtered.map((wb) => (
              <WorkbookCard
                key={wb.id}
                wb={wb}
                onOpen={(id) => navigate(`/s/${id}`)}
                onRename={(w) => {
                  setRenaming(w)
                  setRenameName(w.name)
                }}
                onDelete={setDeleting}
              />
            ))}
          </div>
        )}
      </main>

      {/* Create dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>New sheet</DialogTitle>
            <DialogDescription>Blank spreadsheet with one tab, ready for formulas.</DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              void create()
            }}
          >
            <Input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder='e.g. "Q3 budget"'
              maxLength={120}
            />
            <DialogFooter className="mt-5">
              <DialogClose render={<Button type="button" variant="outline">Cancel</Button>} />
              <Button type="submit" disabled={creating || !newName.trim()}>
                {creating && <Loader2 className="size-4 animate-spin" />}
                Create
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Rename dialog */}
      <Dialog open={renaming !== null} onOpenChange={(o) => !o && setRenaming(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Rename sheet</DialogTitle>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              void rename()
            }}
          >
            <Input autoFocus value={renameName} onChange={(e) => setRenameName(e.target.value)} maxLength={120} />
            <DialogFooter className="mt-5">
              <DialogClose render={<Button type="button" variant="outline">Cancel</Button>} />
              <Button type="submit" disabled={!renameName.trim()}>
                Rename
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <Dialog open={deleting !== null} onOpenChange={(o) => !o && setDeleting(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete “{deleting?.name}”?</DialogTitle>
            <DialogDescription>
              This permanently removes the sheet and its history for everyone. This can&apos;t be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="mt-5">
            <DialogClose render={<Button type="button" variant="outline">Cancel</Button>} />
            <Button type="button" variant="destructive" onClick={() => void remove()}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}