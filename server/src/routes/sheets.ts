/**
 * /api/sheets — flat "My sheets" file list: create, list, rename, delete,
 * plus redeeming share links and the document hydrate endpoint.
 */

import { Hono } from "hono"
import config from "../config.js"
import { db, now } from "../db/connection.js"
import { getAuthUser } from "../middleware/auth.js"
import { canEdit, listWorkbooks, serializeWorkbook, workbookRole, type WorkbookDto } from "../lib/dto.js"
import { initDoc, getDoc, isVaulted, putDoc, getVaultBlob } from "../lib/doc-store.js"
import { newId, generateShareToken } from "../lib/ids.js"
import { blankDoc, type VDoc } from "../lib/ops.js"
import { broadcastToSheet } from "../lib/events.js"

const routes = new Hono()
routes.use("*", async (c, next) => {
  const auth = getAuthUser(c)
  if (!auth) return c.json({ error: "Not authenticated" }, 401)
  await next()
})

const insertWorkbook = db.query(
  `INSERT INTO workbooks (id, owner_id, name, vault, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)`
)
const renameWorkbook = db.query(`UPDATE workbooks SET name = ?, updated_at = ? WHERE id = ?`)
const deleteWorkbook = db.query(`DELETE FROM workbooks WHERE id = ?`)
const touchWorkbook = db.query(`UPDATE workbooks SET updated_at = ? WHERE id = ?`)

function cleanName(name: unknown, max = 120): string | null {
  const s = typeof name === "string" ? name.trim() : ""
  if (!s) return null
  return s.slice(0, max)
}

// GET /api/sheets — all workbooks the caller owns or is shared into
routes.get("/", (c) => {
  const { user } = getAuthUser(c)!
  return c.json(listWorkbooks(user.id))
})

// POST /api/sheets — create blank or from a client-supplied VS1 document
// (used by templates + imports). The document is validated for shape.
routes.post("/", async (c) => {
  const { user } = getAuthUser(c)!
  const body = await c.req.json().catch(() => null)
  const name = cleanName(body?.name, 120)
  if (!name) return c.json({ error: "Name is required" }, 400)

  let doc: VDoc | null = null
  if (body?.document !== undefined && body?.document !== null) {
    if (typeof body.document !== "object") return c.json({ error: "Invalid document" }, 400)
    const raw = body.document as Record<string, unknown>
    if (raw.version !== 1 || !Array.isArray(raw.sheets) || typeof raw.name !== "string") {
      return c.json({ error: "Invalid document shape" }, 400)
    }
    doc = raw as unknown as VDoc
  }

  const id = newId("wb")
  const t = now()
  db.transaction(() => {
    insertWorkbook.run(id, user.id, name, t, t)
    if (doc) putDoc(id, doc)
    else initDoc(id, name)
  })()
  return c.json(serializeWorkbook(id, user.id), 201)
})

// PATCH /api/sheets/:id — rename (owner/editor)
routes.patch("/:id", async (c) => {
  const { user } = getAuthUser(c)!
  const id = c.req.param("id")
  if (!/^[\w-]{1,64}$/.test(id)) return c.json({ error: "Invalid id" }, 400)
  if (!canEdit(id, user.id)) return c.json({ error: "Forbidden" }, 403)

  const body = await c.req.json().catch(() => null)
  if (body?.name !== undefined) {
    const name = cleanName(body.name, 120)
    if (!name) return c.json({ error: "Invalid name" }, 400)
    renameWorkbook.run(name, now(), id)
    touchWorkbook.run(now(), id)
    broadcastToSheet(id, { type: "workbook.rename", sheetId: id, name, actorId: user.id, ts: now() })
  }
  return c.json(serializeWorkbook(id, user.id))
})

// DELETE /api/sheets/:id — owner only
routes.delete("/:id", async (c) => {
  const { user } = getAuthUser(c)!
  const id = c.req.param("id")
  if (!/^[\w-]{1,64}$/.test(id)) return c.json({ error: "Invalid id" }, 400)
  const role = workbookRole(id, user.id)
  if (role !== "owner") return c.json({ error: "Forbidden" }, 403)
  broadcastToSheet(id, { type: "workbook.delete", sheetId: id, actorId: user.id })
  deleteWorkbook.run(id)
  return c.json({ ok: true })
})

// GET /api/sheets/:id — workbook metadata (incl. members + share links)
routes.get("/:id", (c) => {
  const { user } = getAuthUser(c)!
  const id = c.req.param("id")
  if (!/^[\w-]{1,64}$/.test(id)) return c.json({ error: "Invalid id" }, 400)
  const wb = serializeWorkbook(id, user.id)
  if (!wb) return c.json({ error: "Not found" }, 404)
  return c.json(wb)
})

// GET /api/sheets/:id/document — hydrate: metadata + VS1 doc + version.
// Vaulted workbooks return only metadata (content is fetched via /vault).
routes.get("/:id/document", (c) => {
  const { user } = getAuthUser(c)!
  const id = c.req.param("id")
  if (!/^[\w-]{1,64}$/.test(id)) return c.json({ error: "Invalid id" }, 400)
  const wb = serializeWorkbook(id, user.id)
  if (!wb) return c.json({ error: "Not found" }, 404)

  if (isVaulted(id)) {
    return c.json({ sheet: wb, vault: true })
  }
  const loaded = getDoc(id)
  if (!loaded) return c.json({ error: "Document missing" }, 404)
  return c.json({ sheet: wb, vault: false, doc: loaded.doc, version: loaded.version, maxUploadBytes: config.maxUploadBytes })
})

// POST /api/sheets/join/:token — redeem a share link → becomes a member with
// the link's role. The response includes the workbook so the client can open it.
routes.post("/join/:token", async (c) => {
  const { user } = getAuthUser(c)!
  const token = c.req.param("token")
  if (!/^[\w-]{1,64}$/.test(token)) return c.json({ error: "Invalid token" }, 400)

  const link = db
    .query(`SELECT workbook_id, role, enabled FROM share_links WHERE token = ?`)
    .get(token) as { workbook_id: string; role: string; enabled: number } | null
  if (!link || link.enabled !== 1) return c.json({ error: "Invalid or disabled share link" }, 404)

  const wb = db.query(`SELECT vault FROM workbooks WHERE id = ?`).get(link.workbook_id) as { vault: number } | null
  if (!wb) return c.json({ error: "Not found" }, 404)

  if (wb.vault === 1) {
    // Vaulted workbooks are share-proof — the content is encrypted for one user.
    return c.json({ error: "Vaulted sheets cannot be shared" }, 403)
  }

  const isOwner = db.query(`SELECT 1 FROM workbooks WHERE id = ? AND owner_id = ?`).get(link.workbook_id, user.id)
  if (!isOwner) {
    db.query(
      `INSERT INTO workbook_members (workbook_id, user_id, role, added_by, joined_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(workbook_id, user_id) DO UPDATE SET role = workbook_members.role, added_by = workbook_members.added_by`
    ).run(link.workbook_id, user.id, link.role, user.id, now())
  }
  const dto = serializeWorkbook(link.workbook_id, user.id)
  broadcastToSheet(link.workbook_id, { type: "workbook.member", sheetId: link.workbook_id, memberId: user.id })
  return c.json(dto)
})

// POST /api/sheets/:id/share — create a share link for this workbook
routes.post("/:id/share", async (c) => {
  const { user } = getAuthUser(c)!
  const id = c.req.param("id")
  if (!/^[\w-]{1,64}$/.test(id)) return c.json({ error: "Invalid id" }, 400)
  if (workbookRole(id, user.id) !== "owner") return c.json({ error: "Forbidden" }, 403)

  const body = await c.req.json().catch(() => null)
  const role = body?.role === "viewer" ? "viewer" : "editor"
  const token = generateShareToken()
  db.query(`INSERT INTO share_links (token, workbook_id, role, enabled, created_by, created_at) VALUES (?, ?, ?, 1, ?, ?)`).run(
    token,
    id,
    role,
    user.id,
    now()
  )
  return c.json(serializeWorkbook(id, user.id), 201)
})

// DELETE /api/sheets/:id/share/:token — revoke a share link
routes.delete("/:id/share/:token", async (c) => {
  const { user } = getAuthUser(c)!
  const id = c.req.param("id")
  if (workbookRole(id, user.id) !== "owner") return c.json({ error: "Forbidden" }, 403)
  db.query(`DELETE FROM share_links WHERE token = ? AND workbook_id = ?`).run(c.req.param("token"), id)
  return c.json(serializeWorkbook(id, user.id))
})

// PATCH /api/sheets/:id/members/:userId — change a member's role (owner only)
routes.patch("/:id/members/:userId", async (c) => {
  const { user } = getAuthUser(c)!
  const id = c.req.param("id")
  const memberId = c.req.param("userId")
  if (workbookRole(id, user.id) !== "owner") return c.json({ error: "Forbidden" }, 403)

  const body = await c.req.json().catch(() => null)
  const role = body?.role === "viewer" ? "viewer" : body?.role === "editor" ? "editor" : null
  if (!role) return c.json({ error: "Invalid role" }, 400)

  const target = db.query(`SELECT 1 FROM workbook_members WHERE workbook_id = ? AND user_id = ?`).get(id, memberId)
  if (!target) return c.json({ error: "Member not found" }, 404)

  db.query(`UPDATE workbook_members SET role = ? WHERE workbook_id = ? AND user_id = ?`).run(role, id, memberId)
  broadcastToSheet(id, { type: "workbook.member", sheetId: id, memberId })
  return c.json(serializeWorkbook(id, user.id))
})

// DELETE /api/sheets/:id/members/:userId — remove a member (owner only)
routes.delete("/:id/members/:userId", async (c) => {
  const { user } = getAuthUser(c)!
  const id = c.req.param("id")
  const memberId = c.req.param("userId")
  if (workbookRole(id, user.id) !== "owner") return c.json({ error: "Forbidden" }, 403)
  if (memberId === user.id) return c.json({ error: "Cannot remove yourself" }, 400)
  db.query(`DELETE FROM workbook_members WHERE workbook_id = ? AND user_id = ?`).run(id, memberId)
  broadcastToSheet(id, { type: "workbook.member", sheetId: id, memberId })
  return c.json(serializeWorkbook(id, user.id))
})

export default routes
export type { WorkbookDto }