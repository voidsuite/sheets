/**
 * Void Sheets realtime — authenticated WebSocket.
 *
 * The client connects with a workbookId (sheet page). The gateway:
 *   - validates the session (cookie) or bearer token,
 *   - rejects vaulted workbooks (they are single-user by design),
 *   - subscribes the socket to the `sheet:{id}` room,
 *   - tracks presence (who's online) and relays live cursors.
 *
 * Document mutations travel over REST (POST /api/sheets/:id/ops) and the
 * gateway broadcasts them to the room — the socket itself stays dumb.
 */

import type { ServerWebSocket } from "bun"
import { getCookieName, getSession } from "../db/sessions.js"
import { validateBearerToken } from "../lib/oauth.js"
import { workbookRole } from "../lib/dto.js"
import { addToRooms, removeFromRooms, onlineMembers, broadcastToSheet, type ConnMeta } from "../lib/events.js"

export const wsHandlers = {
  open(ws: ServerWebSocket<ConnMeta>) {
    addToRooms(ws)
    const m = ws.data
    if (m.workbookId) {
      const members = onlineMembers(`sheet:${m.workbookId}`)
      ws.send(JSON.stringify({ type: "presence", sheetId: m.workbookId, members }))
      broadcastToSheet(m.workbookId, { type: "presence", sheetId: m.workbookId, members })
    }
  },

  message(ws: ServerWebSocket<ConnMeta>, raw: string | Buffer) {
    const m = ws.data
    let msg: { type?: string; [key: string]: unknown }
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : raw.toString())
    } catch {
      return
    }
    // Clients only send cursor moves; everything else is ignored.
    if (msg.type === "cursor" && m.workbookId) {
      const range = msg.range && typeof msg.range === "object" ? (msg.range as Record<string, unknown>) : null
      broadcastToSheet(m.workbookId, {
        type: "cursor",
        sheetId: m.workbookId,
        userId: m.userId,
        userName: m.userName,
        userPicture: m.userPicture ?? null,
        range: range ? { row: range.row, column: range.column, row2: range.row2, column2: range.column2 } : null,
        ts: Date.now(),
      })
    }
  },

  close(ws: ServerWebSocket<ConnMeta>) {
    const m = ws.data
    removeFromRooms(ws)
    if (m.workbookId) {
      const members = onlineMembers(`sheet:${m.workbookId}`)
      broadcastToSheet(m.workbookId, { type: "presence", sheetId: m.workbookId, members })
    }
  },
}

export async function handleWsUpgrade(req: Request, server: import("bun").Server<unknown>): Promise<Response | undefined> {
  const url = new URL(req.url)
  const workbookId = url.searchParams.get("sheetId") || ""
  if (!workbookId) return new Response("Missing sheetId", { status: 400 })
  if (!/^[\w-]{1,64}$/.test(workbookId)) return new Response("Invalid room id", { status: 400 })

  // Resolve the user: cookie session first, then bearer token.
  const cookieHeader = req.headers.get("cookie") || ""
  const sid = cookieHeader
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${getCookieName()}=`))
    ?.slice(getCookieName().length + 1)
  let user: { id: string; name: string; email: string; picture?: string | null } | null = null

  if (sid) {
    const session = getSession(sid)
    if (session) user = session.user
  }
  if (!user) {
    const auth = req.headers.get("authorization") || ""
    const match = /^Bearer\s+(.+)$/i.exec(auth)
    if (match) {
      try {
        const oidc = await validateBearerToken(match[1])
        user = { id: oidc.id, name: oidc.name, email: oidc.email, picture: oidc.picture }
      } catch {
        /* unauthorized */
      }
    }
  }
  if (!user) return new Response("Unauthorized", { status: 401 })

  // Membership check (owner or shared member). Vaulted sheets are single-user.
  const role = workbookRole(workbookId, user.id)
  if (!role) return new Response("Forbidden", { status: 403 })
  if (role === "vaulted") return new Response("Vaulted sheets are single-user", { status: 403 })

  const ok = server.upgrade(req, {
    data: {
      userId: user.id,
      userName: user.name,
      userPicture: user.picture ?? null,
      workbookId,
    } satisfies ConnMeta,
  })
  return ok ? undefined : new Response("Upgrade failed", { status: 400 })
}