/**
 * /api/auth/* — VoidAuth OAuth proxy with PKCE.
 * The client_secret lives only on the server; the browser gets an httpOnly
 * session cookie and never touches tokens. Browser-SDK mode sends the access
 * token once to /browser-session to mint the same cookie.
 */

import { Hono } from "hono"
import { setCookie, deleteCookie, getCookie } from "hono/cookie"
import config from "../config.js"
import {
  createSession,
  deleteSessionById,
  getCookieName,
  getSession,
  getSessionCookieOptions,
  updateSessionTokens,
  type SessionUser,
} from "../db/sessions.js"
import { storePkceState, takePkceVerifier } from "../db/pkce.js"
import {
  buildAuthorizeParams,
  authorizeUrl,
  exchangeCode,
  refreshTokens,
  revokeToken,
  validateBearerToken,
} from "../lib/oauth.js"

const PKCE_STATE_COOKIE = "sheets_pkce_state"

function pkceStateCookieOptions(): Record<string, string | boolean | number> {
  return {
    httpOnly: true,
    sameSite: "Lax",
    secure: config.appUrl.startsWith("https://"),
    path: "/",
    maxAge: 10 * 60,
  }
}

const auth = new Hono()

// GET /api/auth/login → { authUrl } (starts PKCE, binds state to this browser)
auth.get("/login", async (c) => {
  const { params, verifier, state } = buildAuthorizeParams()
  storePkceState(state, verifier)
  setCookie(c, PKCE_STATE_COOKIE, state, pkceStateCookieOptions())
  return c.json({ authUrl: authorizeUrl(params) })
})

// POST /api/auth/exchange — swap the code, create a session cookie
auth.post("/exchange", async (c) => {
  const body = await c.req.json().catch(() => null)
  const code = body?.code as string | undefined
  const state = body?.state as string | undefined
  const keepMeLoggedIn = body?.keepMeLoggedIn

  if (!code || !state) return c.json({ error: "Missing code or state" }, 400)

  // CSRF: the state must belong to this browser.
  const stateCookie = getCookie(c, PKCE_STATE_COOKIE)
  if (!stateCookie || stateCookie !== state) {
    return c.json({ error: "Invalid OAuth state" }, 400)
  }
  // The verifier lives in SQLite (not memory) so an in-flight login survives
  // gateway restarts. Consumed once, expired states count as missing.
  const verifier = takePkceVerifier(state)
  if (!verifier) return c.json({ error: "Invalid or expired state" }, 400)
  deleteCookie(c, PKCE_STATE_COOKIE)

  try {
    const tokens = await exchangeCode(code, verifier)
    const oidcUser = tokens.user
    const user: SessionUser = {
      id: oidcUser?.id || "",
      name: oidcUser?.name || "",
      email: oidcUser?.email || "",
      picture: oidcUser?.picture,
    }
    if (!user.id) {
      const info = await validateBearerToken(tokens.accessToken)
      user.id = info.id
      user.name = info.name
      user.email = info.email
      user.picture = info.picture
    }

    const kmli = keepMeLoggedIn !== false
    const sessionId = createSession(
      { user, accessToken: tokens.accessToken, refreshToken: tokens.refreshToken || "" },
      kmli
    )
    const cookieMaxAge = kmli ? 30 * 24 * 60 * 60 : undefined
    setCookie(c, getCookieName(), sessionId, getSessionCookieOptions(cookieMaxAge))

    return c.json({ user })
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400)
  }
})

// POST /api/auth/browser-session — browser SDK mode: mint a session from a validated token
auth.post("/browser-session", async (c) => {
  const body = await c.req.json().catch(() => null)
  const accessToken = body?.accessToken as string | undefined
  if (!accessToken) return c.json({ error: "Missing access token" }, 400)

  try {
    const oidcUser = await validateBearerToken(accessToken)
    const user: SessionUser = {
      id: oidcUser.id,
      name: oidcUser.name,
      email: oidcUser.email,
      picture: oidcUser.picture,
    }
    const sessionId = createSession({ user, accessToken, refreshToken: "" }, true)
    setCookie(c, getCookieName(), sessionId, getSessionCookieOptions(30 * 24 * 60 * 60))
    return c.json({ user })
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400)
  }
})

// POST /api/auth/refresh — refresh VoidAuth access token, extend the session
auth.post("/refresh", async (c) => {
  const sessionId = getCookie(c, getCookieName())
  if (!sessionId) return c.json({ error: "No session" }, 401)

  const session = getSession(sessionId)
  if (!session || !session.refreshToken) {
    if (sessionId) deleteCookie(c, getCookieName())
    return c.json({ error: "Session expired" }, 401)
  }

  try {
    const tokens = await refreshTokens(session.refreshToken)
    updateSessionTokens(sessionId, tokens.accessToken, tokens.refreshToken || session.refreshToken)
    const cookieMaxAge = session.keepMeLoggedIn ? 30 * 24 * 60 * 60 : undefined
    setCookie(c, getCookieName(), sessionId, getSessionCookieOptions(cookieMaxAge))
    return c.json({ ok: true, user: session.user })
  } catch {
    deleteSessionById(sessionId)
    deleteCookie(c, getCookieName())
    return c.json({ error: "Session expired" }, 401)
  }
})

// GET /api/auth/me — current user (validates the session)
auth.get("/me", async (c) => {
  const sessionId = getCookie(c, getCookieName())
  if (!sessionId) return c.json({ error: "Not authenticated" }, 401)

  const session = getSession(sessionId)
  if (!session) {
    deleteCookie(c, getCookieName())
    return c.json({ error: "Session expired" }, 401)
  }
  return c.json({ user: session.user })
})

// POST /api/auth/logout — revoke token + clear session
auth.post("/logout", async (c) => {
  const sessionId = getCookie(c, getCookieName())
  if (sessionId) {
    const session = getSession(sessionId)
    if (session?.accessToken) {
      await revokeToken(session.accessToken)
    }
    deleteSessionById(sessionId)
    deleteCookie(c, getCookieName())
  }
  return c.json({ ok: true })
})

export default auth