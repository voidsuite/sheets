/**
 * DTOs + access checks for Void Sheets.
 * Rows are aliased to camelCase in SQL directly, so serializers are thin.
 */

import { db } from "../db/connection.js"

export type WorkbookRole = "owner" | "editor" | "viewer" | "vaulted"

const memberRole = db.query(`
  SELECT role FROM workbook_members WHERE workbook_id = ? AND user_id = ?
`)

const ownerOf = db.query(`SELECT owner_id, vault FROM workbooks WHERE id = ?`)

/**
 * Resolve the caller's role for a workbook:
 *  - "owner" for the creator, "editor"/"viewer" for shared members,
 *  - "vaulted" when the E2E-encrypted workbook belongs to the caller
 *    (single-user by design — realtime is refused, ops don't apply),
 *  - null when the caller has no access at all.
 */
export function workbookRole(workbookId: string, userId: string): WorkbookRole | null {
  const wb = ownerOf.get(workbookId) as { owner_id: string; vault: number } | null
  if (!wb) return null
  const isOwner = wb.owner_id === userId
  const member = isOwner ? null : (memberRole.get(workbookId, userId) as { role: string } | null)
  if (!isOwner && !member) return null
  if (wb.vault === 1) return "vaulted"
  return isOwner ? "owner" : (member!.role as "editor" | "viewer")
}

/** True if the caller may mutate a workbook's document. */
export function canEdit(workbookId: string, userId: string): boolean {
  const role = workbookRole(workbookId, userId)
  return role === "owner" || role === "editor"
}

const workbookRowById = db.query(`
  SELECT id, owner_id, name, vault, position, created_at, updated_at FROM workbooks WHERE id = ?
`)

const membersByWorkbook = db.query(`
  SELECT wm.user_id, wm.role, wm.joined_at, u.name, u.email, u.picture
  FROM workbook_members wm JOIN users u ON u.id = wm.user_id
  WHERE wm.workbook_id = ? ORDER BY wm.joined_at
`)

const linksByWorkbook = db.query(`
  SELECT token, role, enabled, created_by, created_at FROM share_links WHERE workbook_id = ?
`)

const ownerSummary = db.query(`SELECT id, name, email, picture FROM users WHERE id = ?`)

export interface WorkbookMemberDto {
  userId: string
  name: string
  email: string
  picture?: string | null
  role: "editor" | "viewer"
  joinedAt: number
}

export interface ShareLinkDto {
  token: string
  role: "editor" | "viewer"
  enabled: boolean
  createdBy: string
  createdAt: number
}

export interface WorkbookDto {
  id: string
  name: string
  owner: { id: string; name: string; picture?: string | null }
  vault: boolean
  /** The caller's role: owner | editor | viewer. */
  role: "owner" | "editor" | "viewer"
  members: WorkbookMemberDto[]
  shareLinks: ShareLinkDto[]
  createdAt: number
  updatedAt: number
}

export function serializeWorkbook(workbookId: string, userId: string): WorkbookDto | null {
  const wb = workbookRowById.get(workbookId) as
    | { id: string; owner_id: string; name: string; vault: number; position: number; created_at: number; updated_at: number }
    | null
  if (!wb) return null
  const owner = ownerSummary.get(wb.owner_id) as { id: string; name: string; email: string; picture: string | null }
  const members = (membersByWorkbook.all(workbookId) as {
    user_id: string
    name: string
    email: string
    picture: string | null
    role: string
    joined_at: number
  }[]).map((m) => ({
    userId: m.user_id,
    name: m.name,
    email: m.email,
    picture: m.picture,
    role: m.role as "editor" | "viewer",
    joinedAt: m.joined_at,
  }))
  const shareLinks = (linksByWorkbook.all(workbookId) as {
    token: string
    role: string
    enabled: number
    created_by: string
    created_at: number
  }[]).map((l) => ({
    token: l.token,
    role: l.role as "editor" | "viewer",
    enabled: l.enabled === 1,
    createdBy: l.created_by,
    createdAt: l.created_at,
  }))

  let role: "owner" | "editor" | "viewer" = "viewer"
  if (wb.owner_id === userId) role = "owner"
  else {
    const mine = members.find((m) => m.userId === userId)
    if (mine) role = mine.role
  }

  return {
    id: wb.id,
    name: wb.name,
    owner: { id: owner.id, name: owner.name, picture: owner.picture },
    vault: wb.vault === 1,
    role,
    members,
    shareLinks,
    createdAt: wb.created_at,
    updatedAt: wb.updated_at,
  }
}

const listForUser = db.query(`
  SELECT w.id, w.owner_id, w.name, w.vault, w.position, w.created_at, w.updated_at
  FROM workbooks w
  LEFT JOIN workbook_members wm ON wm.workbook_id = w.id AND wm.user_id = ?
  WHERE w.owner_id = ? OR wm.user_id IS NOT NULL
  ORDER BY w.updated_at DESC, w.created_at DESC
`)

export function listWorkbooks(userId: string): WorkbookDto[] {
  const rows = listForUser.all(userId, userId) as {
    id: string
    owner_id: string
    name: string
    vault: number
    position: number
    created_at: number
    updated_at: number
  }[]
  return rows
    .map((wb) => serializeWorkbook(wb.id, userId))
    .filter((w): w is WorkbookDto => w !== null)
}