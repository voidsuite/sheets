/**
 * PKCE state store, persisted in SQLite so an in-flight OAuth login survives
 * gateway restarts. The state cookie is bound to the browser; the verifier
 * must survive any server disruption between the /login redirect and the
 * /exchange callback — hence the DB instead of an in-memory map.
 */

import { db, now } from "./connection.js"

/** States live at most 10 minutes (mirrors the state cookie maxAge). */
const STATE_TTL_MS = 10 * 60 * 1000

const insertState = db.query(`
  INSERT INTO pkce_states (state, verifier, expires_at, created_at)
  VALUES (?, ?, ?, ?)
`)

const selectState = db.query("SELECT verifier, expires_at FROM pkce_states WHERE state = ?")
const deleteState = db.query("DELETE FROM pkce_states WHERE state = ?")
const deleteExpired = db.query("DELETE FROM pkce_states WHERE expires_at < ?")

type StateRow = { verifier: string; expires_at: number }

export function storePkceState(state: string, verifier: string): void {
  insertState.run(state, verifier, now() + STATE_TTL_MS, now())
  // Opportunistic cleanup so the table never grows unbounded.
  deleteExpired.run(now() - STATE_TTL_MS)
}

/**
 * Consume the verifier for a state. Single-use: the row is deleted whether or
 * not verification succeeds, and expired states count as missing.
 */
export function takePkceVerifier(state: string): string | null {
  const row = selectState.get(state) as StateRow | null
  deleteState.run(state)
  if (!row) return null
  if (row.expires_at < now()) return null
  return row.verifier
}