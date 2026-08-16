/**
 * SQLite connection (bun:sqlite). The database lives at DATA_DIR/sheets.db
 * so data persists across restarts — sheets are always there after a reboot.
 *
 * The schema is applied synchronously at module load so every module that
 * imports `db` can prepare statements immediately (import order is safe).
 */

import { Database } from "bun:sqlite"
import { mkdirSync, readFileSync } from "node:fs"
import path from "node:path"
import config from "../config.js"

mkdirSync(config.dataDir, { recursive: true })

export const db = new Database(path.join(config.dataDir, "sheets.db"))
db.exec("PRAGMA journal_mode = WAL;")
db.exec("PRAGMA foreign_keys = ON;")

// Apply schema.sql — idempotent (all statements use IF NOT EXISTS).
const schema = readFileSync(path.join(import.meta.dir, "schema.sql"), "utf8")
db.exec(schema)

db.exec("PRAGMA optimize;")

export function now(): number {
  return Date.now()
}