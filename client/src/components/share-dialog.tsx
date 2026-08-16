/**
 * ShareDialog — the access panel for a sheet.
 *
 * Owners can create revocable "anyone with the link" links (viewer or editor
 * role) and manage the members who joined through them. Editors and viewers
 * can open this panel to see who has access, but every control is owner-only.
 */

import { useMemo, useState } from "react"
import { Check, Copy, Link2, Plus, Trash2, Users } from "lucide-react"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { useAuth } from "@/contexts/auth"
import { useToast } from "@/contexts/toast"
import * as api from "@/lib/api"
import type { Workbook, WorkbookMember } from "@/lib/types"

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

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const ta = document.createElement("textarea")
    ta.value = text
    ta.style.position = "fixed"
    ta.style.opacity = "0"
    document.body.appendChild(ta)
    ta.select()
    try {
      document.execCommand("copy")
      return true
    } catch {
      return false
    } finally {
      document.body.removeChild(ta)
    }
  }
}

export function ShareDialog({
  open,
  onOpenChange,
  wb,
  onChanged,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  wb: Workbook | null
  onChanged: (next: Workbook) => void
}) {
  const { user } = useAuth()
  const { toast } = useToast()
  const [linkRole, setLinkRole] = useState<"viewer" | "editor">("viewer")
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)

  const isOwner = wb?.role === "owner"
  const baseUrl = typeof window !== "undefined" ? window.location.origin : ""
  const members = useMemo(() => wb?.members ?? [], [wb])

  async function refresh(fn: () => Promise<Workbook>, done: string) {
    if (!wb || busy) return
    setBusy(true)
    try {
      const next = await fn()
      onChanged(next)
      toast({ title: done, variant: "success" })
    } catch (err) {
      toast({
        title: "Something went wrong",
        description: err instanceof Error ? err.message : undefined,
        variant: "destructive",
      })
    } finally {
      setBusy(false)
    }
  }

  async function copyLink(token: string) {
    const url = `${baseUrl}/join/${token}`
    const ok = await copyText(url)
    if (!ok) {
      toast({ title: "Couldn't copy the link", variant: "destructive" })
      return
    }
    setCopied(token)
    toast({ title: "Link copied", variant: "success" })
    window.setTimeout(() => setCopied((c) => (c === token ? null : c)), 1600)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Share {wb ? `“${wb.name}”` : "sheet"}</DialogTitle>
          <DialogDescription>
            People with a link can open this sheet. Members sign in with their VoidSuite account.
          </DialogDescription>
        </DialogHeader>

        {wb ? (
          <div className="flex flex-col gap-5 pt-1">
            {/* ---- People ---- */}
            <section className="flex flex-col gap-2">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Users className="size-4 text-muted-foreground" aria-hidden="true" />
                People with access
              </div>

              <div className="flex items-center gap-2.5 rounded-lg border border-border bg-card px-2.5 py-2">
                <Avatar className="size-7">
                  {wb.owner.picture ? <AvatarImage src={wb.owner.picture} alt="" /> : null}
                  <AvatarFallback className="text-[10px]">{initials(wb.owner.name)}</AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{wb.owner.name}</p>
                  {wb.owner.id === user?.id ? <p className="text-xs text-muted-foreground">Your sheet</p> : null}
                </div>
                <Badge variant="secondary">Owner</Badge>
              </div>

              {members.length === 0 ? (
                <p className="px-1 text-xs text-muted-foreground">No members yet — invite someone with a link below.</p>
              ) : null}
              {members.map((m) => (
                <MemberRow
                  key={m.userId}
                  member={m}
                  isOwner={isOwner}
                  busy={busy}
                  onChangeRole={(role) => void refresh(() => api.setMemberRole(wb.id, m.userId, role), "Access updated")}
                  onRemove={() => void refresh(() => api.removeMember(wb.id, m.userId), "Access removed")}
                />
              ))}
            </section>

            <Separator />

            {/* ---- Share links ---- */}
            <section className="flex flex-col gap-2">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Link2 className="size-4 text-muted-foreground" aria-hidden="true" />
                Share via link
              </div>

              {isOwner ? (
                <form
                  className="flex items-center gap-2"
                  onSubmit={(e) => {
                    e.preventDefault()
                    void refresh(() => api.createShareLink(wb.id, linkRole), "Link created")
                  }}
                >
                  <Select value={linkRole} onValueChange={(v) => {
                    if (v === "viewer" || v === "editor") setLinkRole(v)
                  }}>
                    <SelectTrigger className="w-28" aria-label="Link role">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="viewer">Can view</SelectItem>
                      <SelectItem value="editor">Can edit</SelectItem>
                    </SelectContent>
                  </Select>
                  <Button type="submit" className="flex-1 gap-1.5" disabled={busy}>
                    <Plus className="size-3.5" aria-hidden="true" />
                    Create link
                  </Button>
                </form>
              ) : null}

              {wb.shareLinks.length > 0 ? (
                <div className="flex flex-col gap-2">
                  {wb.shareLinks.map((l) => (
                    <div key={l.token} className="flex items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 py-2">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-xs text-muted-foreground">
                          {baseUrl}/join/{l.token}
                        </p>
                        <p className="text-xs">Anyone with the link can {l.role === "editor" ? "edit" : "view"}</p>
                      </div>
                      {isOwner ? (
                        <>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            disabled={busy}
                            onClick={() => void copyLink(l.token)}
                            aria-label="Copy link"
                          >
                            {copied === l.token ? <Check className="size-4" /> : <Copy className="size-4" />}
                          </Button>
                          <TooltipProvider>
                            <Tooltip>
                              <TooltipTrigger
                                render={
                                  <Button
                                    variant="ghost"
                                    size="icon-sm"
                                    className="text-destructive"
                                    disabled={busy}
                                    onClick={() => void refresh(() => api.revokeShareLink(wb.id, l.token), "Link revoked")}
                                    aria-label="Revoke link"
                                  >
                                    <Trash2 className="size-4" />
                                  </Button>
                                }
                              />
                              <TooltipContent>Revoke link</TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                        </>
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : isOwner ? (
                <p className="px-1 text-xs text-muted-foreground">
                  No links yet — anyone with a link can join without an invite.
                </p>
              ) : null}
            </section>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Loading…</p>
        )}
      </DialogContent>
    </Dialog>
  )
}

function MemberRow({
  member,
  isOwner,
  busy,
  onChangeRole,
  onRemove,
}: {
  member: WorkbookMember
  isOwner: boolean
  busy: boolean
  onChangeRole: (role: "viewer" | "editor") => void
  onRemove: () => void
}) {
  return (
    <div className="flex items-center gap-2.5 rounded-lg border border-border bg-card px-2.5 py-2">
      <Avatar className="size-7">
        {member.picture ? <AvatarImage src={member.picture} alt="" /> : null}
        <AvatarFallback className="text-[10px]">{initials(member.name)}</AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{member.name}</p>
        {member.email ? <p className="truncate text-xs text-muted-foreground">{member.email}</p> : null}
      </div>
      {isOwner ? (
        <>
          <Select value={member.role} onValueChange={(v) => {
            if (v === "viewer" || v === "editor") onChangeRole(v)
          }}>
            <SelectTrigger size="sm" className="w-28" aria-label={`Role for ${member.name}`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="viewer">Can view</SelectItem>
              <SelectItem value="editor">Can edit</SelectItem>
            </SelectContent>
          </Select>
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="text-destructive"
                    disabled={busy}
                    onClick={onRemove}
                    aria-label={`Remove ${member.name}`}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                }
              />
              <TooltipContent>Remove access</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </>
      ) : (
        <Badge variant="secondary" className="capitalize">
          {member.role}
        </Badge>
      )}
    </div>
  )
}