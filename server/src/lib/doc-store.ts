/**
 * Document store — persists the authoritative VS1 document, the op log, and
 * version snapshots in SQLite. All reads/writes are synchronous (bun:sqlite);
 * batches are wrapped in transactions so seq assignment and doc updates are
 * atomic.
 */

import { db, now } from "../db/connection.js"
import { newId } from "./ids.js"
import { applyOps, blankDoc, type Op, type VDoc } from "./ops.js"

const KEEP_OPS = 500 // ops retained after a checkpoint; older ones are pruned

const selectDoc = db.query(`SELECT document, version, updated_at FROM workbook_docs WHERE workbook_id = ?`)
const insertDoc = db.query(
  `INSERT INTO workbook_docs (workbook_id, document, version, updated_at) VALUES (?, ?, 0, ?)`
)
const upsertDoc = db.query(
  `INSERT INTO workbook_docs (document, version, updated_at, workbook_id) VALUES (?, ?, ?, ?)
   ON CONFLICT(workbook_id) DO UPDATE SET document = excluded.document, version = excluded.version, updated_at = excluded.updated_at`
)
const deleteDoc = db.query(`DELETE FROM workbook_docs WHERE workbook_id = ?`)

const insertOp = db.query(
  `INSERT INTO ops (id, workbook_id, seq, op, actor_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`
)
const selectOpsSince = db.query(
  `SELECT seq, op, actor_id, created_at FROM ops WHERE workbook_id = ? AND seq > ? ORDER BY seq ASC`
)
const selectMaxSeq = db.query(`SELECT COALESCE(MAX(seq), 0) AS m FROM ops WHERE workbook_id = ?`)
const deleteOpsUpTo = db.query(`DELETE FROM ops WHERE workbook_id = ? AND seq <= ?`)
const deleteAllOps = db.query(`DELETE FROM ops WHERE workbook_id = ?`)

export interface LoadedDoc {
  doc: VDoc
  version: number
}

export function getDoc(workbookId: string): LoadedDoc | null {
  const row = selectDoc.get(workbookId) as { document: string; version: number } | null
  if (!row) return null
  try {
    return { doc: JSON.parse(row.document) as VDoc, version: row.version }
  } catch {
    return null
  }
}

/** Create the initial blank VS1 document for a new workbook. */
export function initDoc(workbookId: string, name: string): void {
  insertDoc.run(workbookId, JSON.stringify(blankDoc(name)), now())
}

/** Replace the stored doc wholesale (used by restore + vault unvault). Upserts. */
export function putDoc(workbookId: string, doc: VDoc): number {
  const loaded = getDoc(workbookId)
  const version = (loaded?.version ?? 0) + 1
  upsertDoc.run(JSON.stringify(doc), version, now(), workbookId)
  return version
}

export function latestOpsSince(workbookId: string, afterSeq: number): { seq: number; op: Op; actorId: string; createdAt: number }[] {
  return (selectOpsSince.all(workbookId, afterSeq) as { seq: number; op: string; actor_id: string; created_at: number }[]).map(
    (r) => ({ seq: r.seq, op: JSON.parse(r.op) as Op, actorId: r.actor_id, createdAt: r.created_at })
  )
}

export interface AppendResult {
  ok: boolean
  error?: string
  doc?: VDoc
  version?: number
  seqs?: number[]
}

/**
 * Append a batch of ops: validate + apply to the stored doc, assign monotonic
 * seqs, persist ops + doc, atomically. Mutates the caller's `doc` only on
 * success (the applied copy).
 */
export function appendOps(workbookId: string, ops: Op[], actorId: string): AppendResult {
  if (!ops.length) return { ok: true }
  const tx = db.transaction((wo: string, opList: Op[], actor: string): AppendResult => {
    const loaded = getDoc(wo)
    if (!loaded) return { ok: false, error: "Workbook has no document" }
    const working: VDoc = JSON.parse(JSON.stringify(loaded.doc))
    const err = applyOps(working, opList)
    if (err) return { ok: false, error: err }

    const { m } = selectMaxSeq.get(wo) as { m: number }
    const t = now()
    let seq = m
    for (const op of opList) {
      seq += 1
      insertOp.run(newId("op"), wo, seq, JSON.stringify(op), actor, t)
    }
    upsertDoc.run(JSON.stringify(working), loaded.version + 1, t, wo)
    return { ok: true, doc: working, version: loaded.version + 1, seqs: Array.from({ length: opList.length }, (_, i) => m + 1 + i) }
  })
  return tx(workbookId, ops, actorId)
}

// --- versions ---------------------------------------------------------------

const insertVersion = db.query(
  `INSERT INTO versions (id, workbook_id, kind, name, snapshot, author_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
)
const selectVersions = db.query(
  `SELECT id, kind, name, author_id, created_at FROM versions WHERE workbook_id = ? ORDER BY created_at DESC`
)
const selectVersion = db.query(`SELECT id, workbook_id, snapshot FROM versions WHERE id = ? AND workbook_id = ?`)

export interface VersionMeta {
  id: string
  kind: "checkpoint" | "named"
  name: string | null
  authorId: string
  createdAt: number
}

/** Snapshot the current doc as a version; optionally prune old ops. */
export function saveVersion(workbookId: string, kind: "checkpoint" | "named", name: string | null, authorId: string): boolean {
  const loaded = getDoc(workbookId)
  if (!loaded) return false
  insertVersion.run(newId("ver"), workbookId, kind, name, JSON.stringify(loaded.doc), authorId, now())
  deleteOpsUpTo.run(workbookId, latestOpSeq(workbookId) - KEEP_OPS)
  return true
}

function latestOpSeq(workbookId: string): number {
  return (selectMaxSeq.get(workbookId) as { m: number }).m
}

export function listVersions(workbookId: string): VersionMeta[] {
  return (selectVersions.all(workbookId) as { id: string; kind: string; name: string | null; author_id: string; created_at: number }[]).map(
    (v) => ({ id: v.id, kind: v.kind as "checkpoint" | "named", name: v.name, authorId: v.author_id, createdAt: v.created_at })
  )
}

/** Restore a version: replace the doc, reset the op log. Returns new version. */
export function restoreVersion(workbookId: string, versionId: string): number | null {
  const row = selectVersion.get(versionId, workbookId) as { snapshot: string } | null
  if (!row) return null
  let doc: VDoc
  try {
    doc = JSON.parse(row.snapshot) as VDoc
  } catch {
    return null
  }
  const tx = db.transaction((wo: string, d: VDoc): number | null => {
    const loaded = getDoc(wo)
    if (!loaded) return null
    const v = loaded.version + 1
    upsertDoc.run(JSON.stringify(d), v, now(), wo)
    deleteAllOps.run(wo)
    return v
  })
  return tx(workbookId, doc)
}

// --- vault blobs --------------------------------------------------------------

const selectBlob = db.query(`SELECT data, version, updated_at FROM vault_blobs WHERE workbook_id = ?`)
const upsertBlob = db.query(
  `INSERT INTO vault_blobs (workbook_id, data, version, updated_at) VALUES (?, ?, ?, ?)
   ON CONFLICT(workbook_id) DO UPDATE SET data = excluded.data, version = excluded.version, updated_at = excluded.updated_at`
)
const deleteBlob = db.query(`DELETE FROM vault_blobs WHERE workbook_id = ?`)

export function getVaultBlob(workbookId: string): { data: string; version: number } | null {
  const row = selectBlob.get(workbookId) as { data: string; version: number } | null
  return row ? { data: row.data, version: row.version } : null
}

export function saveVaultBlob(workbookId: string, data: string): number {
  const current = getVaultBlob(workbookId)
  const version = (current?.version ?? 0) + 1
  upsertBlob.run(workbookId, data, version, now())
  return version
}

export function clearVaultBlob(workbookId: string): void {
  deleteBlob.run(workbookId)
}

// --- lifecycle ----------------------------------------------------------------

export function deleteWorkbookData(workbookId: string): void {
  // schema uses ON DELETE CASCADE from workbooks; rows here are removed
  // automatically. This is a no-op placeholder for clarity.
  void workbookId
}

export function isVaulted(workbookId: string): boolean {
  const row = db.query(`SELECT vault FROM workbooks WHERE id = ?`).get(workbookId) as { vault: number } | null
  return row?.vault === 1
}