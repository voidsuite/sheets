/**
 * /api/sheets/:id/ops — the collaboration write path.
 *
 * Clients POST batches of validated ops (optimistically applied locally);
 * the gateway appends them to the authoritative VS1 document, assigns
 * monotonic seqs atomically, and broadcasts the batch to the room so peers
 * can apply it without refetching. A GET with `?after=seq` supports silent
 * catch-up after a reconnect.
 */

import { Hono } from "hono"
import { getAuthUser } from "../middleware/auth.js"
import { canEdit, workbookRole } from "../lib/dto.js"
import { appendOps, latestOpsSince } from "../lib/doc-store.js"
import { MAX_OP_BATCH, type Op } from "../lib/ops.js"
import { broadcastToSheet } from "../lib/events.js"

const routes = new Hono()
routes.use("*", async (c, next) => {
  const auth = getAuthUser(c)
  if (!auth) return c.json({ error: "Not authenticated" }, 401)
  await next()
})

// POST /api/sheets/:id/ops
routes.post("/:id/ops", async (c) => {
  const { user } = getAuthUser(c)!
  const id = c.req.param("id")
  if (!/^[\w-]{1,64}$/.test(id)) return c.json({ error: "Invalid id" }, 400)
  const role = workbookRole(id, user.id)
  if (role === "vaulted") return c.json({ error: "Vaulted sheets are single-user" }, 403)
  if (!canEdit(id, user.id)) return c.json({ error: "Forbidden" }, 403)

  const body = await c.req.json().catch(() => null)
  const ops = body?.ops
  if (!Array.isArray(ops) || ops.length === 0 || ops.length > MAX_OP_BATCH) {
    return c.json({ error: "Invalid op batch" }, 400)
  }
  for (const op of ops) {
    if (!op || typeof op !== "object" || typeof (op as Op).cmd !== "string") {
      return c.json({ error: "Invalid op" }, 400)
    }
  }

  const result = appendOps(id, ops as Op[], user.id)
  if (!result.ok) return c.json({ error: result.error ?? "Failed to apply ops" }, 400)

  broadcastToSheet(id, {
    type: "ops",
    sheetId: id,
    ops: ops as Op[],
    seqs: result.seqs,
    actorId: user.id,
    actorName: user.name,
    ts: Date.now(),
  })

  return c.json({ ok: true, seqs: result.seqs, version: result.version })
})

// GET /api/sheets/:id/ops?after=seq — catch-up / replay
routes.get("/:id/ops", (c) => {
  const { user } = getAuthUser(c)!
  const id = c.req.param("id")
  if (!/^[\w-]{1,64}$/.test(id)) return c.json({ error: "Invalid id" }, 400)
  const role = workbookRole(id, user.id)
  if (!role || role === "vaulted") return c.json({ error: "Forbidden" }, 403)

  const after = Number.parseInt(c.req.query("after") || "0", 10)
  const from = Number.isFinite(after) && after >= 0 ? after : 0
  return c.json({ ops: latestOpsSince(id, from) })
})

export default routes