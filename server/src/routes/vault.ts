/**
 * /api/sheets/:id/vault — E2E vault path.
 *
 * The workbooks.vault flag flips 0 ↔ 1. While vaulted, the server stores ONE
 * opaque AES-GCM blob and never sees document content; ops, versions, share
 * links, and memberships are disallowed (single-user by design). Toggling:
 *  - enable:  the client sends the already-encrypted blob of the current doc;
 *  - disable: the client decrypts locally and sends the plaintext VS1 doc —
 *             the sheet becomes a normal synced, shareable workbook again.
 */

import { Hono } from "hono"
import { db, now } from "../db/connection.js"
import { getAuthUser } from "../middleware/auth.js"
import { workbookRole } from "../lib/dto.js"
import { clearVaultBlob, getVaultBlob, putDoc, saveVaultBlob } from "../lib/doc-store.js"
import type { VDoc } from "../lib/ops.js"
import { broadcastToSheet } from "../lib/events.js"

const routes = new Hono()
routes.use("*", async (c, next) => {
  const auth = getAuthUser(c)
  if (!auth) return c.json({ error: "Not authenticated" }, 401)
  await next()
})

const MAX_BLOB_BYTES = 8 * 1024 * 1024 // 8 MiB of ciphertext

// GET /api/sheets/:id/vault — fetch the encrypted blob (owner of a vaulted sheet)
routes.get("/:id/vault", (c) => {
  const { user } = getAuthUser(c)!
  const id = c.req.param("id")
  if (!/^[\w-]{1,64}$/.test(id)) return c.json({ error: "Invalid id" }, 400)
  const role = workbookRole(id, user.id)
  if (role !== "vaulted") return c.json({ error: accessError(role) }, role ? 403 : 404)

  const blob = getVaultBlob(id)
  if (!blob) return c.json({ error: "Vault blob missing" }, 404)
  return c.json({ data: blob.data, version: blob.version })
})

// POST /api/sheets/:id/vault — save the encrypted blob
routes.post("/:id/vault", async (c) => {
  const { user } = getAuthUser(c)!
  const id = c.req.param("id")
  if (!/^[\w-]{1,64}$/.test(id)) return c.json({ error: "Invalid id" }, 400)
  const role = workbookRole(id, user.id)
  if (role !== "vaulted") return c.json({ error: accessError(role) }, role ? 403 : 404)

  const body = await c.req.json().catch(() => null)
  const data = typeof body?.data === "string" ? body.data : ""
  if (!data) return c.json({ error: "Missing blob" }, 400)
  if (data.length > MAX_BLOB_BYTES) return c.json({ error: "Blob too large" }, 413)

  const version = saveVaultBlob(id, data)
  db.query(`UPDATE workbooks SET updated_at = ? WHERE id = ?`).run(now(), id)
  return c.json({ ok: true, version })
})

// POST /api/sheets/:id/vault/toggle — enable (body: {enable:true, blob}) or
// disable (body: {enable:false, document}) the vault on a workbook.
routes.post("/:id/vault/toggle", async (c) => {
  const { user } = getAuthUser(c)!
  const id = c.req.param("id")
  if (!/^[\w-]{1,64}$/.test(id)) return c.json({ error: "Invalid id" }, 400)
  const role = workbookRole(id, user.id)
  if (role !== "owner") return c.json({ error: "Only the owner can toggle the vault" }, 403)

  const body = await c.req.json().catch(() => null)
  const enable = body?.enable === true

  // Validate inputs before entering the transaction so failures are 400s,
  // not rollbacks.
  if (enable) {
    const data = typeof body?.blob === "string" ? body.blob : ""
    if (!data || data.length > MAX_BLOB_BYTES) return c.json({ error: "Missing or invalid blob" }, 400)
  } else {
    const doc = body?.document as Record<string, unknown> | null | undefined
    if (!doc || typeof doc !== "object") return c.json({ error: "Missing document" }, 400)
    if (doc.version !== 1 || !Array.isArray(doc.sheets) || typeof doc.name !== "string") {
      return c.json({ error: "Invalid document shape" }, 400)
    }
  }

  db.transaction(() => {
    if (enable) {
      db.query(`UPDATE workbooks SET vault = 1, updated_at = ? WHERE id = ?`).run(now(), id)
      saveVaultBlob(id, body.blob as string)
      // Single-user mode: drop sharing state and server-side doc/versions.
      db.query(`DELETE FROM share_links WHERE workbook_id = ?`).run(id)
      db.query(`DELETE FROM workbook_members WHERE workbook_id = ?`).run(id)
      db.query(`DELETE FROM ops WHERE workbook_id = ?`).run(id)
      db.query(`DELETE FROM versions WHERE workbook_id = ?`).run(id)
      db.query(`DELETE FROM workbook_docs WHERE workbook_id = ?`).run(id)
    } else {
      db.query(`UPDATE workbooks SET vault = 0, updated_at = ? WHERE id = ?`).run(now(), id)
      putDoc(id, body.document as unknown as VDoc)
      clearVaultBlob(id)
    }
  })()

  broadcastToSheet(id, { type: "workbook.vault", sheetId: id, vault: enable, actorId: user.id })
  return c.json({ ok: true })
})

function accessError(role: string | null): string {
  return role === null ? "Not found" : "Forbidden"
}

export default routes