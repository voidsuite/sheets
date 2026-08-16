/**
 * /api/sheets/:id/versions — version history.
 *
 * Automatic "checkpoint" snapshots are debounced client-side (editor) and
 * pushed here; "named" versions are explicit. Restoring replaces the
 * authoritative doc and resets the op log. Vaulted workbooks don't use this
 * route — their history lives client-side as encrypted snapshots.
 */

import { Hono } from "hono"
import { getAuthUser } from "../middleware/auth.js"
import { canEdit, workbookRole } from "../lib/dto.js"
import { listVersions, restoreVersion, saveVersion } from "../lib/doc-store.js"
import { broadcastToSheet } from "../lib/events.js"

const routes = new Hono()
routes.use("*", async (c, next) => {
  const auth = getAuthUser(c)
  if (!auth) return c.json({ error: "Not authenticated" }, 401)
  await next()
})

// GET /api/sheets/:id/versions
routes.get("/:id/versions", (c) => {
  const { user } = getAuthUser(c)!
  const id = c.req.param("id")
  const role = workbookRole(id, user.id)
  if (!role || role === "vaulted") return c.json({ error: "Forbidden" }, 403)
  return c.json({ versions: listVersions(id) })
})

// POST /api/sheets/:id/versions — create a named version
routes.post("/:id/versions", async (c) => {
  const { user } = getAuthUser(c)!
  const id = c.req.param("id")
  const role = workbookRole(id, user.id)
  if (role === "vaulted") return c.json({ error: "Vaulted sheets are single-user" }, 403)
  if (!canEdit(id, user.id)) return c.json({ error: "Forbidden" }, 403)

  const body = await c.req.json().catch(() => null)
  const kind = body?.kind === "named" ? "named" : "checkpoint"
  const rawName = typeof body?.name === "string" ? body.name.trim() : ""
  const name = kind === "named" && rawName ? rawName.slice(0, 120) : null
  if (kind === "named" && !name) return c.json({ error: "Name is required" }, 400)

  if (!saveVersion(id, kind, name, user.id)) return c.json({ error: "Document missing" }, 404)
  broadcastToSheet(id, { type: "workbook.version", sheetId: id, actorId: user.id, kind })
  return c.json({ ok: true, versions: listVersions(id) })
})

// POST /api/sheets/:id/versions/restore — restore a snapshot
routes.post("/:id/versions/restore", async (c) => {
  const { user } = getAuthUser(c)!
  const id = c.req.param("id")
  const role = workbookRole(id, user.id)
  if (role === "vaulted") return c.json({ error: "Vaulted sheets are single-user" }, 403)
  if (!canEdit(id, user.id)) return c.json({ error: "Forbidden" }, 403)

  const body = await c.req.json().catch(() => null)
  const versionId = typeof body?.versionId === "string" ? body.versionId : ""
  if (!versionId) return c.json({ error: "Missing versionId" }, 400)

  const version = restoreVersion(id, versionId)
  if (version === null) return c.json({ error: "Version not found" }, 404)
  broadcastToSheet(id, { type: "workbook.restore", sheetId: id, actorId: user.id, version })
  return c.json({ ok: true, version })
})

export default routes