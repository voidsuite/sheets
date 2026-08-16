/**
 * Auth middleware — resolves the current user on every API request from:
 *   1. the httpOnly session cookie (recommended path), or
 *   2. a Bearer access token (browser SDK path), validated against VoidAuth
 *      userinfo and mapped to the local users table.
 * Fails with 401 when neither is present or valid.
 */

import { getCookie, setCookie } from "hono/cookie"
import type { Context, MiddlewareHandler } from "hono"
import { getCookieName, getSession, getSessionCookieOptions, upsertUser, type SessionUser } from "../db/sessions.js"
import { validateBearerToken } from "../lib/oauth.js"

export interface AuthPrincipal {
  user: SessionUser
  source: "cookie" | "bearer"
  sessionId?: string
}

export function getAuthUser(c: Context): AuthPrincipal | null {
  return c.get("auth") ?? null
}

function authPayloadFromSession(session: { user: SessionUser; id: string }): AuthPrincipal {
  return {
    user: session.user,
    source: "cookie",
    sessionId: session.id,
  }
}

export const authRequired: MiddlewareHandler = async (c, next) => {
  const cookieName = getCookieName()

  // 1. Cookie session
  const sid = getCookie(c, cookieName)
  if (sid) {
    const session = getSession(sid)
    if (session) {
      c.set("auth", authPayloadFromSession(session))
      await next()
      return
    }
    // Expired session — clear the cookie.
    setCookie(c, cookieName, "", { ...getSessionCookieOptions(), maxAge: 0 })
  }

  // 2. Bearer token (browser SDK mode)
  const header = c.req.header("Authorization") || ""
  const match = /^Bearer\s+(.+)$/i.exec(header)
  if (match) {
    try {
      const oidcUser = await validateBearerToken(match[1])
      const user = upsertUser({
        id: oidcUser.id,
        name: oidcUser.name,
        email: oidcUser.email,
        picture: oidcUser.picture,
      })
      c.set("auth", { user, source: "bearer" })
      await next()
      return
    } catch {
      /* fall through to 401 */
    }
  }

  return c.json({ error: "Not authenticated" }, 401)
}

/** Optional auth — available to /api/auth/me-like endpoints. */
export const authOptional: MiddlewareHandler = async (c, next) => {
  const cookieName = getCookieName()
  const sid = getCookie(c, cookieName)
  if (sid) {
    const session = getSession(sid)
    if (session) {
      c.set("auth", authPayloadFromSession(session))
      await next()
      return
    }
  }
  const header = c.req.header("Authorization") || ""
  const match = /^Bearer\s+(.+)$/i.exec(header)
  if (match) {
    try {
      const oidcUser = await validateBearerToken(match[1])
      const user = upsertUser({
        id: oidcUser.id,
        name: oidcUser.name,
        email: oidcUser.email,
        picture: oidcUser.picture,
      })
      c.set("auth", { user, source: "bearer" })
    } catch {
      /* anonymous */
    }
  }
  await next()
}