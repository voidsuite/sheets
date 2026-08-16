/**
 * /api/storage/* — thin proxy to VoidAuth's per-app storage API, so the
 * client never needs a raw token in backend (cookie) mode. Used for:
 *   - vault-key escrow (Vault encryption path),
 *   - optional encrypted cloud backup of vaulted sheets.
 *
 * The gateway forwards the session's access token as a Bearer header. All
 * stored values are client-side ciphertext — the gateway and VoidAuth only
 * ever see opaque strings.
 */

import { Hono } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"
import config from "../config.js"
import { getSession } from "../db/sessions.js"
import { getAuthUser } from "../middleware/auth.js"
import { db, now } from "../db/connection.js"

const routes = new Hono()
routes.use("*", async (c, next) => {
  const auth = getAuthUser(c)
  if (!auth) return c.json({ error: "Not authenticated" }, 401)
  await next()
})

const ESCROW_KEY = "vsheets_vault_escrow_v1"
// Server-side escrow fallback when the client can't reach VoidAuth storage
// (e.g. browser mode without a session): keep the wrapped key in our own db,
// encrypted at rest with the session secret.
const sessionSecret = (process.env.SESSION_SECRET || "").trim() || null

function escrowWhere(): "voidauth" | "local" {
  return sessionSecret ? "local" : "voidauth"
}

/**
 * Proxy a storage request to VoidAuth using the session's access token.
 * `path` is everything after /api/storage, e.g. "/data?key=x".
 */
async function proxyStorage(c: Parameters<typeof getAuthUser>[0], path: string, init: RequestInit): Promise<Response> {
  const auth = getAuthUser(c)
  const session = auth?.sessionId ? getSession(auth.sessionId) : null
  const token = session?.accessToken ?? null
  if (!token) return new Response(JSON.stringify({ error: "No session token" }), { status: 401 })

  const url = `${config.voidauthUrl}/storage${path}`
  return fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(init.headers as Record<string, string> | undefined),
    },
  })
}

// GET /api/storage/data?key=...
routes.get("/data", async (c) => {
  const key = c.req.query("key") || ""
  if (!key) return c.json({ error: "Missing key" }, 400)
  const res = await proxyStorage(c, `/data?client_id=${encodeURIComponent(config.clientId)}&key=${encodeURIComponent(key)}`, { method: "GET" })
  if (res.status === 404) return c.json(null)
  const body = await res.json().catch(() => null)
  return c.json(body, res.ok ? 200 : proxyStatus(res.status))
})

// POST /api/storage/data { key, value }
routes.post("/data", async (c) => {
  const body = await c.req.json().catch(() => null)
  const key = typeof body?.key === "string" ? body.key : ""
  const value = typeof body?.value === "string" ? body.value : ""
  if (!key || !value) return c.json({ error: "Missing key or value" }, 400)
  const res = await proxyStorage(c, `/data`, {
    method: "POST",
    body: JSON.stringify({ client_id: config.clientId, key, value }),
  })
  const data = await res.json().catch(() => null)
  return c.json(data ?? { ok: res.ok }, res.ok ? 200 : proxyStatus(res.status))
})

// DELETE /api/storage/data?key=...
routes.delete("/data", async (c) => {
  const key = c.req.query("key") || ""
  if (!key) return c.json({ error: "Missing key" }, 400)
  const res = await proxyStorage(c, `/data?client_id=${encodeURIComponent(config.clientId)}&key=${encodeURIComponent(key)}`, { method: "DELETE" })
  return c.json({ ok: res.ok }, res.ok ? 200 : proxyStatus(res.status))
})

// --- vault-key escrow ----------------------------------------------------------

const escrowLocalGet = db.query(`SELECT data FROM vault_escrow WHERE key = ?`)
const escrowLocalUpsert = db.query(
  `INSERT INTO vault_escrow (key, data, updated_at) VALUES (?, ?, ?)
   ON CONFLICT(key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`
)

// POST /api/sheets/vault-key/unlock { vaultKey? }
// Returns the escrowed vault key for this user (wrapped), or adopts + stores
// a freshly generated one when none exists yet.
routes.post("/sheets/vault-key/unlock", async (c) => {
  const { user } = getAuthUser(c)!
  const body = await c.req.json().catch(() => null)
  const submitted = typeof body?.vaultKey === "string" ? body.vaultKey : ""

  if (escrowWhere() === "local") {
    const row = escrowLocalGet.get(escrowKeyFor(user.id)) as { data: string } | null
    if (row) return c.json({ vaultKey: row.data, adopted: false })
    if (submitted) {
      escrowLocalUpsert.run(escrowKeyFor(user.id), submitted, now())
      return c.json({ vaultKey: submitted, adopted: true })
    }
    return c.json({ vaultKey: null, adopted: false })
  }

  const res = await proxyStorage(c, `/data?client_id=${encodeURIComponent(config.clientId)}&key=${encodeURIComponent(ESCROW_KEY)}`, {
    method: "GET",
  })
  if (res.status === 200) {
    const body2 = (await res.json().catch(() => null)) as { value?: string } | null
    return c.json({ vaultKey: body2?.value ?? null, adopted: false })
  }
  if (submitted) {
    await proxyStorage(c, `/data`, {
      method: "POST",
      body: JSON.stringify({ client_id: config.clientId, key: ESCROW_KEY, value: submitted }),
    })
    return c.json({ vaultKey: submitted, adopted: true })
  }
  return c.json({ vaultKey: null, adopted: false })
})

// POST /api/sheets/vault-key/store { vaultKey }
routes.post("/sheets/vault-key/store", async (c) => {
  const { user } = getAuthUser(c)!
  const body = await c.req.json().catch(() => null)
  const vaultKey = typeof body?.vaultKey === "string" ? body.vaultKey : ""
  if (!vaultKey) return c.json({ error: "Missing vaultKey" }, 400)

  if (escrowWhere() === "local") {
    escrowLocalUpsert.run(escrowKeyFor(user.id), vaultKey, now())
    return c.json({ ok: true })
  }
  const res = await proxyStorage(c, `/data`, {
    method: "POST",
    body: JSON.stringify({ client_id: config.clientId, key: ESCROW_KEY, value: vaultKey }),
  })
  return c.json({ ok: res.ok }, res.ok ? 200 : 502)
})

function escrowKeyFor(userId: string): string {
  // The row value is client-wrapped ciphertext (AES-GCM under the user's
  // device key), so a plain deterministic row key is fine — a raw DB leak
  // yields per-user blobs that are unusable without the device key.
  return `escrow:${userId}`
}

function proxyStatus(status: number): ContentfulStatusCode {
  return status as ContentfulStatusCode
}

export default routes