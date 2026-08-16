/**
 * Session store, persisted in SQLite so logins survive server restarts —
 * sign in once, stay signed in (chat-app style).
 */

import { db, now } from "./connection.js"
import { newToken } from "../lib/ids.js"
import config from "../config.js"

export interface SessionUser {
  id: string
  name: string
  email: string
  picture?: string | null
}

export interface SessionData {
  id: string
  user: SessionUser
  accessToken: string
  refreshToken: string
  expiresAt: number
  keepMeLoggedIn: boolean
}

const SESSION_DURATION_KMLI = 30 * 24 * 60 * 60 * 1000
const SESSION_DURATION_DEFAULT = 7 * 24 * 60 * 60 * 1000

export function getCookieName(): string {
  return "sheets_sid"
}

const insertSession = db.query(`
  INSERT INTO sessions (id, user_id, access_token, refresh_token, expires_at, keep_me_logged_in, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`)

const selectSession = db.query(`
  SELECT s.id, s.access_token, s.refresh_token, s.expires_at, s.keep_me_logged_in,
         u.id AS user_id, u.name AS user_name, u.email AS user_email, u.picture AS user_picture
  FROM sessions s JOIN users u ON u.id = s.user_id
  WHERE s.id = ?
`)

const deleteSession = db.query("DELETE FROM sessions WHERE id = ?")
const deleteExpired = db.query("DELETE FROM sessions WHERE expires_at < ?")
const updateTokens = db.query("UPDATE sessions SET access_token = ?, refresh_token = ?, expires_at = ? WHERE id = ?")

type SessionRow = {
  id: string
  access_token: string
  refresh_token: string
  expires_at: number
  keep_me_logged_in: number
  user_id: string
  user_name: string
  user_email: string
  user_picture: string | null
}

export function createSession(
  data: { user: SessionUser; accessToken: string; refreshToken: string },
  keepMeLoggedIn?: boolean
): string {
  const id = newToken(32)
  const kmli = keepMeLoggedIn !== false
  const duration = kmli ? SESSION_DURATION_KMLI : SESSION_DURATION_DEFAULT
  upsertUser(data.user)
  insertSession.run(id, data.user.id, data.accessToken, data.refreshToken, now() + duration, kmli ? 1 : 0, now())
  return id
}

export function getSession(id: string): SessionData | null {
  if (!id) return null
  const row = selectSession.get(id) as SessionRow | null
  if (!row) return null
  if (now() > row.expires_at) {
    deleteSession.run(id)
    return null
  }
  return {
    id: row.id,
    accessToken: row.access_token,
    refreshToken: row.refresh_token,
    expiresAt: row.expires_at,
    keepMeLoggedIn: row.keep_me_logged_in === 1,
    user: {
      id: row.user_id,
      name: row.user_name,
      email: row.user_email,
      picture: row.user_picture,
    },
  }
}

export function updateSessionTokens(id: string, accessToken: string, refreshToken: string, extend = true): void {
  const session = getSession(id)
  if (!session) return
  const expiresAt = extend ? now() + SESSION_DURATION_KMLI : session.expiresAt
  updateTokens.run(accessToken, refreshToken, expiresAt, id)
}

export function deleteSessionById(id: string): void {
  deleteSession.run(id)
}

export function getSessionCookieOptions(maxAge?: number): Record<string, string | boolean | number> {
  const isSecure = config.appUrl.startsWith("https://")
  const options: Record<string, string | boolean | number> = {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    secure: isSecure,
  }
  if (maxAge !== undefined) options.maxAge = maxAge
  return options
}

// --- Users ---

const upsertUserStmt = db.query(`
  INSERT INTO users (id, email, name, picture, last_seen_at, created_at)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    email = excluded.email,
    name = excluded.name,
    picture = COALESCE(excluded.picture, users.picture),
    last_seen_at = excluded.last_seen_at
`)

const selectUserStmt = db.query("SELECT id, name, email, picture FROM users WHERE id = ?")

export interface StoredUser {
  id: string
  name: string
  email: string
  picture?: string | null
}

export function upsertUser(user: SessionUser): StoredUser {
  upsertUserStmt.run(user.id, user.email, user.name, user.picture ?? null, now(), now())
  return { id: user.id, name: user.name, email: user.email, picture: user.picture ?? null }
}

export function getUserById(id: string): StoredUser | null {
  const row = selectUserStmt.get(id) as StoredUser | null
  return row ?? null
}

export function touchUser(id: string): void {
  db.query("UPDATE users SET last_seen_at = ? WHERE id = ?").run(now(), id)
}

// Sweep expired sessions periodically.
setInterval(() => {
  deleteExpired.run(now())
}, 10 * 60 * 1000).unref?.()