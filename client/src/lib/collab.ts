/**
 * CollabSession — the client half of Void Sheets realtime collaboration.
 *
 * The server is authoritative. The client:
 *   - keeps a local VS1 mirror (`doc`) that it applies every op to, so the
 *     mirror always equals the last state it POSTed or received;
 *   - captures Univer's edit commands, debounces, diffs the live grid against
 *     the mirror and POSTs the minimal op batch (optimistic – the grid is
 *     already the future state; the POST is how the server catches up);
 *   - applies remote ops (from the WS room or the reconnect catch-up GET)
 *     to the grid through Univer's own command/mutation ids;
 *   - dedupes its own echoes by seq (monotonic, server-assigned) and keeps
 *     one in-flight batch at a time so a lost ack can be resolved on
 *     reconnect without double-applying;
 *   - relays presence and live cursors.
 *
 * Read-only members don't POST — any edit Univer lets them make is
 * auto-undone (`revert()`), because Univer's `beforeCommandExecuted`
 * listeners cannot veto.
 */

import { Direction } from "@univerjs/core"
import type { ICellData, IDisposable, IRange } from "@univerjs/core"
import * as api from "./api"
import { applyOpToDoc, diffVs1 } from "./ops-client"
import { snapshotToVs1, vs1ToSnapshot } from "./workbook"
import type { CellRef, Op, PresenceMember, VDoc } from "./types"
import type { UniverRuntime } from "./univer-factory"

export type CollabStatus = "connecting" | "online" | "offline" | "error"

export interface CursorInfo {
  userId: string
  userName: string
  userPicture?: string | null
  /** Univer range of the remote user's active selection (one per user). */
  range: CellRef | null
  ts: number
}

export interface CollabEvents {
  onPresence?: (members: PresenceMember[]) => void
  onCursors?: (cursors: Map<string, CursorInfo>) => void
  onStatus?: (status: CollabStatus) => void
  /** Fired when a hard resync rewrote the grid (rare; useful for a toast). */
  onSoftResync?: () => void
}

interface CollabOptions {
  runtime: UniverRuntime
  sheetId: string
  editable: boolean
  user: { id: string; name: string; picture?: string | null }
  initialDoc: VDoc
  initialVersion: number
  events?: CollabEvents
}

/** Command/mutation ids whose execution means "the document changed". */
const EDIT_COMMANDS = new Set([
  // commands
  "sheet.command.set-range-values",
  "sheet.command.set-style",
  "sheet.command.clear-selection-content",
  "sheet.command.clear-selection-all",
  "sheet.command.clear-selection-format",
  "sheet.command.auto-fill",
  "sheet.command.refill",
  "sheet.command.copy-down",
  "sheet.command.copy-right",
  "sheet.command.optional-paste",
  "sheet.command.paste",
  "sheet.command.paste-value",
  "sheet.command.paste-format",
  "sheet.command.insert-row-by-range",
  "sheet.command.insert-col-by-range",
  "sheet.command.insert-row",
  "sheet.command.insert-col",
  "sheet.command.insert-row-before",
  "sheet.command.insert-row-after",
  "sheet.command.insert-col-before",
  "sheet.command.insert-col-after",
  "sheet.command.insert-multi-rows-above",
  "sheet.command.insert-multi-rows-after",
  "sheet.command.remove-row-by-range",
  "sheet.command.remove-col-by-range",
  "sheet.command.remove-row",
  "sheet.command.remove-col",
  "sheet.command.append-row",
  "sheet.command.insert-range-move-down",
  "sheet.command.insert-range-move-right",
  "sheet.command.delete-range-move-up",
  "sheet.command.delete-range-move-left",
  "sheet.command.move-rows",
  "sheet.command.move-cols",
  "sheet.command.reorder-range",
  "sheet.command.add-worksheet-merge",
  "sheet.command.add-worksheet-merge-all",
  "sheet.command.add-worksheet-merge-horizontal",
  "sheet.command.add-worksheet-merge-vertical",
  "sheet.command.remove-worksheet-merge",
  "sheet.command.set-row-height",
  "sheet.command.delta-row-height",
  "sheet.command.set-worksheet-col-width",
  "sheet.command.delta-column-width",
  "sheet.command.set-worksheet-name",
  "sheet.command.set-worksheet-order",
  "sheet.command.set-workbook-name",
  "sheet.command.insert-sheet",
  "sheet.command.remove-sheet",
  "sheet.command.copy-sheet",
  "sheet.command.insert-defined-name",
  "sheet.command.remove-defined-name",
  "sheet.command.set-selection-move",
  "univer.command.undo",
  "univer.command.redo",
  // mutations (the changes underneath the commands above)
  "sheet.mutation.set-range-values",
  "sheet.mutation.set-row-data",
  "sheet.mutation.set-col-data",
  "sheet.mutation.set-worksheet-row-height",
  "sheet.mutation.set-worksheet-col-width",
  "sheet.mutation.set-worksheet-name",
  "sheet.mutation.set-worksheet-order",
  "sheet.mutation.set-workbook-name",
  "sheet.mutation.set-worksheet-hidden",
  "sheet.mutation.set-col-hidden",
  "sheet.mutation.set-row-hidden",
  "sheet.mutation.set-tab-color",
  "sheet.mutation.insert-row",
  "sheet.mutation.insert-col",
  "sheet.mutation.remove-rows",
  "sheet.mutation.remove-col",
  "sheet.mutation.insert-sheet",
  "sheet.mutation.remove-sheet",
  "sheet.mutation.add-worksheet-merge",
  "sheet.mutation.remove-worksheet-merge",
  "sheet.mutation.set.numfmt",
  "sheet.mutation.remove.numfmt",
  "sheet.mutation.move-rows",
  "sheet.mutation.move-cols",
  "sheet.mutation.move-range",
  "sheet.mutation.reorder-range",
  "sheet.mutation.set-frozen",
  "sheet.mutation.toggle-gridlines",
])

/** Operations we never treat as edits (selection, scroll, zoom, activation). */
const NON_EDIT_COMMANDS = new Set([
  "sheet.operation.set-selections",
  "sheet.operation.set-scroll",
  "sheet.operation.set-activate-sheet",
  "sheet.operation.set-viewport",
  "sheet.command.change-zoom-ratio",
  "sheet.operation.set-zoom-ratio",
  "sheet.command.set-worksheet-activate",
])

const CURSOR_TTL_MS = 10_000
const CURSOR_SEND_INTERVAL_MS = 2_500
const RESYNC_RETRY_MS = 800

function toUniverRange(ref: CellRef): IRange {
  return { startRow: ref.row, startColumn: ref.column, endRow: ref.row2, endColumn: ref.column2 }
}

export class CollabSession {
  private readonly runtime: UniverRuntime
  private readonly sheetId: string
  private readonly unitId: string
  private readonly editable: boolean
  private readonly user: { id: string; name: string; picture?: string | null }
  private readonly events: CollabEvents

  /** Local VS1 mirror — the last state we've POSTed or received. */
  private doc: VDoc
  /** Highest seq applied locally (own acked or remote). */
  private seq: number

  private ws: WebSocket | null = null
  private status: CollabStatus = "connecting"
  private reconnectAttempts = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private disposed = false

  /** Ops computed from the grid but not yet POSTed (never assigned seqs). */
  private queue: Op[] = []
  /** The single batch currently POSTed whose ack we haven't received. */
  private inFlight: { seqs: number[]; ops: Op[] } | null = null
  private posting = false

  private captureDisposable: IDisposable | null = null
  private cursorDisposable: IDisposable | null = null
  private syncTimer: ReturnType<typeof setTimeout> | null = null
  private cursorInterval: ReturnType<typeof setInterval> | null = null

  /** True while we apply remote ops — suppress capture of those commands. */
  private applyingRemote = false
  /** True while we auto-undo a read-only member's edit. */
  private reverting = false

  private presence: PresenceMember[] = []
  private cursors = new Map<string, CursorInfo>()
  private lastCursorSent = 0

  constructor(options: CollabOptions) {
    this.runtime = options.runtime
    this.sheetId = options.sheetId
    this.unitId = options.sheetId
    this.editable = options.editable
    this.user = options.user
    this.events = options.events ?? {}
    this.doc = structuredClone(options.initialDoc)
    this.seq = options.initialVersion
  }

  // --- lifecycle ----------------------------------------------------------

  start(): void {
    if (this.disposed) return
    this.captureDisposable = this.runtime.univerAPI.onCommandExecuted((command) => this.onCommand(command))
    this.connect()
  }

  dispose(): void {
    this.disposed = true
    this.captureDisposable?.dispose()
    this.cursorDisposable?.dispose()
    if (this.syncTimer) clearTimeout(this.syncTimer)
    if (this.cursorInterval) clearInterval(this.cursorInterval)
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    if (this.ws) {
      this.ws.onopen = null
      this.ws.onmessage = null
      this.ws.onclose = null
      this.ws.onerror = null
      this.ws.close()
      this.ws = null
    }
  }

  // --- connection ---------------------------------------------------------

  private connect(): void {
    if (this.disposed) return
    this.setStatus("connecting")
    let ws: WebSocket
    try {
      ws = api.openSheetSocket(this.sheetId)
    } catch {
      this.scheduleReconnect()
      return
    }
    this.ws = ws
    ws.onopen = () => {
      this.reconnectAttempts = 0
      this.setStatus("online")
      void this.catchUp()
    }
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(String(event.data)) as {
          type?: string
          sheetId?: string
          [key: string]: unknown
        }
        this.onWsEvent(msg)
      } catch {
        /* malformed frame – ignore */
      }
    }
    ws.onclose = () => {
      if (this.ws === ws) this.ws = null
      if (!this.disposed) {
        this.setStatus("offline")
        this.scheduleReconnect()
      }
    }
    ws.onerror = () => {
      try {
        ws.close()
      } catch {
        /* already closed */
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer) return
    const delay = Math.min(1_000 * 2 ** this.reconnectAttempts, 8_000)
    this.reconnectAttempts += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
  }

  private setStatus(status: CollabStatus): void {
    if (this.status === status) return
    this.status = status
    this.events.onStatus?.(status)
  }

  // --- inbound WS events --------------------------------------------------

  private onWsEvent(msg: { type?: string; [key: string]: unknown }): void {
    switch (msg.type) {
      case "presence": {
        this.presence = (msg.members as PresenceMember[]) ?? []
        this.events.onPresence?.(this.presence)
        return
      }
      case "ops": {
        const ops = (msg.ops as Op[]) ?? []
        const seqs = (msg.seqs as number[]) ?? []
        this.applyIncomingOps(ops, seqs)
        return
      }
      case "cursor": {
        if (typeof msg.userId !== "string" || msg.userId === this.user.id) return
        const range = msg.range as CellRef | null
        this.cursors.set(msg.userId, {
          userId: msg.userId,
          userName: typeof msg.userName === "string" ? msg.userName : "Someone",
          userPicture: (msg.userPicture as string | null) ?? null,
          range,
          ts: Date.now(),
        })
        this.pruneCursors()
        this.events.onCursors?.(this.cursors)
        return
      }
      default:
        return
    }
  }

  private pruneCursors(): void {
    const cutoff = Date.now() - CURSOR_TTL_MS
    for (const [userId, cursor] of this.cursors) {
      if (cursor.ts < cutoff) this.cursors.delete(userId)
    }
  }

  /**
   * Apply a stream of ops (WS echo/broadcast or catch-up GET). Skips our
   * own echoes (already applied optimistically) and anything already in
   * the mirror, then applies the rest to grid + mirror in seq order.
   */
  private applyIncomingOps(ops: Op[], seqs: number[]): void {
    if (this.disposed || ops.length === 0 || ops.length !== seqs.length) return
    const work: { seq: number; op: Op }[] = []
    let maxSeq = this.seq
    for (let i = 0; i < ops.length; i++) {
      const seq = seqs[i]
      maxSeq = Math.max(maxSeq, seq)
      if (seq <= this.seq) continue // own ack echo or duplicate
      if (this.inFlight && this.inFlight.seqs.includes(seq)) continue // own echo, ack in flight
      work.push({ seq, op: ops[i] })
    }
    this.seq = maxSeq
    if (work.length > 0) this.applyOpsLocally(work.map((w) => w.op), /*syncMirrorOnly*/ false)
  }

  /** Apply ops to the mirror, and (unless mirror-only) to the grid. */
  private applyOpsLocally(ops: Op[], post: boolean, grid = !post): void {
    if (ops.length === 0) return
    if (grid && !this.applyingRemote) {
      this.applyingRemote = true
      try {
        for (const op of ops) {
          try {
            applyOpToDoc(this.doc, op)
            void this.applyOpToGrid(op)
          } catch (err) {
            console.error("[collab] failed to apply op to grid", op, err)
          }
        }
      } finally {
        this.applyingRemote = false
      }
    } else {
      for (const op of ops) applyOpToDoc(this.doc, op)
    }
    if (post) this.post(ops)
  }

  // --- local edit capture -------------------------------------------------

  private onCommand(command: { id: string; [key: string]: unknown }): void {
    if (this.applyingRemote || this.reverting || this.disposed) return

    if (!this.editable) {
      // Read-only member: undo any edit Univer let through.
      if (!EDIT_COMMANDS.has(command.id) || NON_EDIT_COMMANDS.has(command.id)) return
      this.reverting = true
      void this.runtime.univerAPI
        .undo()
        .catch(() => {})
        .finally(() => {
          this.reverting = false
        })
      return
    }

    if (!EDIT_COMMANDS.has(command.id) || NON_EDIT_COMMANDS.has(command.id)) return
    this.scheduleSync()
  }

  private scheduleSync(): void {
    if (this.syncTimer) clearTimeout(this.syncTimer)
    this.syncTimer = setTimeout(() => {
      this.syncTimer = null
      void this.sync()
    }, 150)
  }

  /**
   * Diff the live grid against the mirror and POST the delta. Adopting the
   * grid snapshot as the new mirror makes the whole pipeline self-healing:
   * any command we missed is folded in on the next edit.
   */
  private async sync(): Promise<void> {
    if (this.disposed || !this.editable || this.applyingRemote) return
    const wb = this.runtime.univerAPI.getActiveWorkbook()
    if (!wb) return
    const next = snapshotToVs1(wb.save())
    const ops = diffVs1(this.doc, next)
    this.doc = next
    if (ops.length > 0) this.post(ops)
  }

  // --- outbound POST ------------------------------------------------------

  private post(ops: Op[]): void {
    this.queue.push(...ops)
    void this.pump()
  }

  private async pump(): Promise<void> {
    if (this.posting || this.disposed || this.queue.length === 0) return
    this.posting = true
    try {
      while (this.queue.length > 0 && !this.disposed) {
        const batch = this.queue.splice(0, 200)
        try {
          const result = await api.postOps(this.sheetId, batch)
          this.inFlight = null
          for (const seq of result.seqs) this.seq = Math.max(this.seq, seq)
        } catch (err) {
          // Keep the failed batch in flight and let reconnect resolve it:
          // the server appends batches atomically, so a lost ack is either
          // present in the catch-up (adopt) or absent (repost).
          this.inFlight = this.inFlight ?? { seqs: [], ops: batch }
          if (this.inFlight.ops === batch) {
            // network-level failure – reconnect will sort it out
            this.ws?.close()
          } else {
            // validation failure – the diff produced a bad op (e.g. stale
            // index after a peer's structural op) -> hard resync
            console.error("[collab] op batch rejected", err)
            void this.hardResync()
          }
          return
        }
      }
    } finally {
      this.posting = false
    }
  }

  // --- reconnect catch-up -------------------------------------------------

  /** After (re)connect: fetch anything we missed and reconcile. */
  private async catchUp(): Promise<void> {
    if (this.disposed) return
    try {
      const { ops } = await api.getOpsSince(this.sheetId, this.seq)
      const entries = ops ?? []
      if (entries.length > 0) {
        const work = entries.filter((e) => e.seq > this.seq && !(this.inFlight && this.inFlight.seqs.includes(e.seq)))
        if (work.length > 0) {
          this.seq = Math.max(this.seq, ...entries.map((e) => e.seq))
          this.applyOpsLocally(work.map((e) => e.op), false)
        } else {
          this.seq = Math.max(this.seq, ...entries.map((e) => e.seq))
        }
        // If our in-flight batch is fully accounted for in the catch-up,
        // it was persisted – drop it. Otherwise retry once, then repost.
        if (
          this.inFlight &&
          this.inFlight.seqs.every((s) => entries.some((e) => e.seq === s)) &&
          this.inFlight.seqs.length > 0
        ) {
          this.inFlight = null
        } else if (this.inFlight) {
          setTimeout(() => void this.retryInFlight(), RESYNC_RETRY_MS)
        }
      }
      // Re-drive any local edits that happened while we were offline.
      this.scheduleSync()
    } catch {
      this.setStatus("offline")
      this.scheduleReconnect()
    }
  }

  private async retryInFlight(): Promise<void> {
    if (this.disposed) return
    try {
      const { ops } = await api.getOpsSince(this.sheetId, this.seq)
      const entries = ops ?? []
      const found = this.inFlight && this.inFlight.seqs.some((s) => entries.some((e) => e.seq === s))
      if (found && this.inFlight) {
        this.seq = Math.max(this.seq, ...this.inFlight.seqs)
        this.inFlight = null
        return
      }
      // Not persisted (or lost) – repost the batch as new ops.
      if (this.inFlight && this.inFlight.ops.length > 0) {
        const opsToRepost = this.inFlight.ops
        this.inFlight = null
        this.queue.unshift(...opsToRepost)
        void this.pump()
      }
    } catch {
      /* keep in-flight; next reconnect retries */
    }
  }

  /**
   * Converge with the server without reloading: fetch the authoritative doc,
   * diff it against the mirror, and apply the delta to grid + mirror.
   * Used when a batch the client produced was rejected.
   */
  private async hardResync(): Promise<void> {
    if (this.disposed) return
    try {
      const hydrated = await api.hydrateSheet(this.sheetId)
      if (hydrated.vault || !hydrated.doc) return
      const target = hydrated.doc
      const ops = diffVs1(this.doc, target)
      if (ops.length > 0) this.applyOpsLocally(ops, false, true)
      this.doc = structuredClone(target)
      this.seq = hydrated.version ?? 0
      this.inFlight = null
      this.events.onSoftResync?.()
      this.scheduleSync()
    } catch {
      this.setStatus("error")
      this.scheduleReconnect()
    }
  }

  // --- applying remote ops to the grid -------------------------------------

  private async run(id: string, params: Record<string, unknown>): Promise<boolean> {
    try {
      const res = await this.runtime.univerAPI.executeCommand(id, params)
      return res !== false
    } catch (err) {
      console.error("[collab] command failed", id, err)
      return false
    }
  }

  /** Translate one VS1 op into Univer command(s) on the live grid. */
  private async applyOpToGrid(op: Op): Promise<void> {
    const unitId = this.unitId
    switch (op.cmd) {
      case "set-range-values": {
        const range = op.params.range as CellRef
        const values = op.params.values as unknown[][]
        const cellValue: Record<number, Record<number, ICellData | null>> = {}
        for (let r = 0; r < values.length; r++) {
          const row = values[r]
          const targetRow: Record<number, ICellData | null> = {}
          for (let c = 0; c < row.length; c++) {
            const raw = row[c]
            if (raw === null || raw === undefined) {
              targetRow[range.column + c] = null
            } else if (typeof raw === "object") {
              const cell: ICellData = {}
              const o = raw as Record<string, unknown>
              if (o.v !== undefined) cell.v = o.v as string | number | boolean
              if (typeof o.f === "string") cell.f = o.f
              if (typeof o.t === "number") cell.t = o.t as ICellData["t"]
              if (o.style && typeof o.style === "object" && Object.keys(o.style as Record<string, unknown>).length) {
                cell.s = o.style as never
              }
              targetRow[range.column + c] = cell.v !== undefined || cell.f !== undefined || cell.s !== undefined ? cell : null
            } else {
              targetRow[range.column + c] = { v: raw as string | number | boolean }
            }
          }
          cellValue[range.row + r] = targetRow
        }
        await this.run("sheet.mutation.set-range-values", { unitId, subUnitId: op.sheetId!, cellValue })
        return
      }
      case "set-range-style": {
        const range = toUniverRange(op.params.range as CellRef)
        const styles = op.params.styles as Record<string, unknown> | null
        if (styles === null) {
          // ClearSelectionFormatCommand also clears numfmt – accepted v1
          // limitation; next diff sync reconciles.
          await this.run("sheet.command.clear-selection-format", { unitId, subUnitId: op.sheetId!, ranges: [range] })
        } else {
          const sub = op.sheetId!
          const cellValue: Record<number, Record<number, ICellData>> = {}
          for (let r = range.startRow; r <= range.endRow; r++) {
            cellValue[r] ??= {}
            for (let c = range.startColumn; c <= range.endColumn; c++) cellValue[r][c] = { s: styles as never }
          }
          await this.run("sheet.mutation.set-range-values", { unitId, subUnitId: sub, cellValue })
        }
        return
      }
      case "set-range-numfmt": {
        const range = toUniverRange(op.params.range as CellRef)
        const pattern = op.params.pattern as string | null
        if (pattern === null || pattern === "") {
          await this.run("sheet.mutation.remove.numfmt", { unitId, subUnitId: op.sheetId!, ranges: [range] })
        } else {
          await this.run("sheet.mutation.set.numfmt", {
            unitId,
            subUnitId: op.sheetId!,
            values: { v1: { ranges: [range] } },
            refMap: { v1: { pattern } },
          })
        }
        return
      }
      case "insert-rows": {
        const meta = this.doc.sheets.find((s) => s.id === op.sheetId)
        if (!meta) return
        const index = op.params.index as number
        const count = op.params.count as number
        // Mirror already includes this insert (applied before grid), so the
        // pre-op row count is what the grid currently has.
        const rowCount = meta.rowCount - count
        const atEnd = index >= rowCount
        const startRow = atEnd ? rowCount : index
        await this.run("sheet.command.insert-row-by-range", {
          unitId,
          subUnitId: op.sheetId!,
          direction: atEnd ? Direction.DOWN : Direction.UP,
          range: { startRow, endRow: startRow + count - 1, startColumn: 0, endColumn: meta.columnCount - 1 },
        })
        return
      }
      case "insert-cols": {
        const meta = this.doc.sheets.find((s) => s.id === op.sheetId)
        if (!meta) return
        const index = op.params.index as number
        const count = op.params.count as number
        const colCount = meta.columnCount - count
        const atEnd = index >= colCount
        const startCol = atEnd ? colCount : index
        await this.run("sheet.command.insert-col-by-range", {
          unitId,
          subUnitId: op.sheetId!,
          direction: atEnd ? Direction.RIGHT : Direction.LEFT,
          range: { startRow: 0, endRow: meta.rowCount - 1, startColumn: startCol, endColumn: startCol + count - 1 },
        })
        return
      }
      case "remove-rows": {
        const meta = this.doc.sheets.find((s) => s.id === op.sheetId)
        if (!meta) return
        const index = op.params.index as number
        const count = op.params.count as number
        await this.run("sheet.command.remove-row-by-range", {
          unitId,
          subUnitId: op.sheetId!,
          range: { startRow: index, endRow: index + count - 1, startColumn: 0, endColumn: meta.columnCount - 1 },
        })
        return
      }
      case "remove-cols": {
        const meta = this.doc.sheets.find((s) => s.id === op.sheetId)
        if (!meta) return
        const index = op.params.index as number
        const count = op.params.count as number
        await this.run("sheet.command.remove-col-by-range", {
          unitId,
          subUnitId: op.sheetId!,
          range: { startRow: 0, endRow: meta.rowCount - 1, startColumn: index, endColumn: index + count - 1 },
        })
        return
      }
      case "merge-cells": {
        await this.run("sheet.command.add-worksheet-merge", {
          unitId,
          subUnitId: op.sheetId!,
          selections: [toUniverRange(op.params.range as CellRef)],
          defaultMerge: true,
        })
        return
      }
      case "unmerge-cells": {
        await this.run("sheet.command.remove-worksheet-merge", {
          unitId,
          subUnitId: op.sheetId!,
          ranges: [toUniverRange(op.params.range as CellRef)],
        })
        return
      }
      case "set-row-height": {
        const meta = this.doc.sheets.find((s) => s.id === op.sheetId)
        if (!meta) return
        const rows = op.params.rows as number[]
        const heights = op.params.heights as (number | null)[]
        const colEnd = meta.columnCount - 1
        const def = meta.defaultRowHeight ?? 24
        for (let i = 0; i < rows.length; i++) {
          const h = heights[i]
          const value = typeof h === "number" && h > 0 ? h : def
          await this.run("sheet.mutation.set-worksheet-row-height", {
            unitId,
            subUnitId: op.sheetId!,
            ranges: [{ startRow: rows[i], endRow: rows[i], startColumn: 0, endColumn: colEnd }],
            rowHeight: value,
          })
        }
        return
      }
      case "set-col-width": {
        const meta = this.doc.sheets.find((s) => s.id === op.sheetId)
        if (!meta) return
        const cols = op.params.cols as number[]
        const widths = op.params.widths as (number | null)[]
        const rowEnd = meta.rowCount - 1
        const def = meta.defaultColumnWidth ?? 88
        for (let i = 0; i < cols.length; i++) {
          const w = widths[i]
          const value = typeof w === "number" && w > 0 ? w : def
          await this.run("sheet.mutation.set-worksheet-col-width", {
            unitId,
            subUnitId: op.sheetId!,
            ranges: [{ startRow: 0, endRow: rowEnd, startColumn: cols[i], endColumn: cols[i] }],
            colWidth: value,
          })
        }
        return
      }
      case "rename-sheet": {
        await this.run("sheet.mutation.set-worksheet-name", { unitId, subUnitId: op.sheetId!, name: op.params.name as string })
        return
      }
      case "move-sheet": {
        const fromOrder = this.doc.sheets.findIndex((s) => s.id === op.sheetId)
        if (fromOrder < 0) return
        await this.run("sheet.mutation.set-worksheet-order", {
          unitId,
          subUnitId: op.sheetId!,
          fromOrder,
          toOrder: op.params.index as number,
        })
        return
      }
      case "insert-sheet": {
        const sheet = op.params as unknown as {
          sheetId?: string
          name?: string
          index?: number
          rowCount?: number
          columnCount?: number
          tabColor?: string
        }
        const vs: VDoc = {
          version: 1,
          name: this.doc.name,
          sheets: [
            {
              id: sheet.sheetId ?? "sheet-new",
              name: (sheet.name ?? "Sheet").trim(),
              rowCount: typeof sheet.rowCount === "number" ? sheet.rowCount : 100,
              columnCount: typeof sheet.columnCount === "number" ? sheet.columnCount : 26,
              cells: {},
              merges: [],
              filters: null,
              validations: [],
              conditionalFormats: [],
              rowHeights: {},
              colWidths: {},
              tabColor: typeof sheet.tabColor === "string" ? sheet.tabColor : null,
            },
          ],
          namedRanges: [],
        }
        const snapshot = vs1ToSnapshot(vs, unitId)
        const worksheetData = snapshot.sheets?.[vs.sheets[0].id]
        if (worksheetData) {
          await this.run("sheet.command.insert-sheet", { unitId, index: sheet.index ?? 0, sheet: worksheetData })
        }
        return
      }
      case "remove-sheet": {
        await this.run("sheet.command.remove-sheet", { unitId, subUnitId: op.sheetId! })
        return
      }
      case "duplicate-sheet": {
        const source = this.doc.sheets.find((s) => s.id === op.sheetId)
        if (!source) return
        const id = op.params.newId as string
        const copy: VDoc = {
          version: 1,
          name: this.doc.name,
          sheets: [
            {
              id,
              name: (typeof op.params.name === "string" ? op.params.name : `${source.name} (copy)`).trim(),
              rowCount: source.rowCount,
              columnCount: source.columnCount,
              cells: {},
              merges: [],
              filters: null,
              validations: [],
              conditionalFormats: [],
              rowHeights: {},
              colWidths: {},
              tabColor: source.tabColor ?? null,
            },
          ],
          namedRanges: [],
        }
        const snapshot = vs1ToSnapshot(copy, unitId)
        const worksheetData = snapshot.sheets?.[id]
        if (worksheetData) {
          const index = this.doc.sheets.indexOf(source) + 1
          await this.run("sheet.command.insert-sheet", { unitId, index, sheet: worksheetData })
        }
        return
      }
      case "rename-workbook": {
        await this.run("sheet.mutation.set-workbook-name", { unitId, name: op.params.name as string })
        return
      }
      // Opaque ops – no grid translation (content that survives via the
      // grid snapshot once local sync runs).
      case "set-filter":
      case "set-validation":
      case "set-conditional-format":
      case "set-named-range":
        return
    }
  }

  // --- cursors ------------------------------------------------------------

  /**
   * Start relaying this user's active selection. Called by the page once
   * the engine is ready; safe to call multiple times.
   */
  enableCursors(): void {
    if (this.cursorDisposable) return
    this.cursorDisposable = this.runtime.univerAPI.onCommandExecuted((command) => {
      if (command.id !== "sheet.operation.set-selections") return
      this.sendCursor()
    })
    this.cursorInterval = setInterval(() => this.sendCursor(true), CURSOR_SEND_INTERVAL_MS)
  }

  private sendCursor(force = false): void {
    const now = Date.now()
    if (!force && now - this.lastCursorSent < 400) return
    const wb = this.runtime.univerAPI.getActiveWorkbook()
    const sheet = wb?.getActiveSheet()
    const range = sheet?.getSelection()?.getActiveRange()?.getRange()
    if (!range) return
    const ref: CellRef = {
      row: range.startRow,
      column: range.startColumn,
      row2: range.endRow,
      column2: range.endColumn,
    }
    this.lastCursorSent = now
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "cursor", range: ref }))
    }
  }
}