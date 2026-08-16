/**
 * Client-side VS1 op engine.
 *
 * The server is authoritative and validates every batch; the client mirrors
 * the server's apply semantics (server/src/lib/ops.ts) so its local VS1 copy
 * stays in step while applying remote ops, and uses `diffVs1` to turn the
 * Univer grid's live state into a minimal batch of ops before posting.
 */

import type { Op, VCell, VDoc, VSheet } from "@/lib/types"

function cellKey(r: number, c: number): string {
  return `${r}_${c}`
}

function findSheet(doc: VDoc, sheetId: string): VSheet | null {
  return doc.sheets.find((s) => s.id === sheetId) ?? null
}

function toInt(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null
}

function toRange(v: unknown): { row: number; column: number; row2: number; column2: number } | null {
  if (!v || typeof v !== "object") return null
  const o = v as Record<string, unknown>
  const row = toInt(o.row)
  const column = toInt(o.column)
  const row2 = toInt(o.row2)
  const column2 = toInt(o.column2)
  if (row === null || column === null || row2 === null || column2 === null) return null
  if (row2 < row || column2 < column) return null
  return { row, column, row2, column2 }
}

/** Server-matching cleanse: primitives wrap to { v }, objects drop nulls. */
function cleanCell(raw: unknown): VCell | null {
  if (raw === null || raw === undefined) return null
  if (typeof raw !== "object") return { v: raw } as VCell
  const out: VCell = {}
  for (const [k, val] of Object.entries(raw as Record<string, unknown>)) {
    if (val !== null && val !== undefined) out[k] = val
  }
  return Object.keys(out).length ? out : null
}

/** Apply one op to a VS1 doc in place (client mirror of the server engine). */
export function applyOpToDoc(doc: VDoc, op: Op): void {
  switch (op.cmd) {
    case "set-range-values": {
      const sheet = findSheet(doc, op.sheetId!)!
      const range = toRange(op.params.range)!
      const values = op.params.values as unknown[][]
      for (let r = 0; r < values.length; r++) {
        for (let c = 0; c < values[r].length; c++) {
          const key = cellKey(range.row + r, range.column + c)
          const cell = cleanCell(values[r][c])
          if (!cell) delete sheet.cells[key]
          else sheet.cells[key] = cell
        }
      }
      return
    }
    case "set-range-style": {
      const sheet = findSheet(doc, op.sheetId!)!
      const range = toRange(op.params.range)!
      const styles = op.params.styles as Record<string, unknown> | null
      for (let r = range.row; r <= range.row2; r++) {
        for (let c = range.column; c <= range.column2; c++) {
          const key = cellKey(r, c)
          const cell = sheet.cells[key] ?? {}
          if (styles === null) delete cell.style
          else cell.style = { ...styles }
          sheet.cells[key] = cell
        }
      }
      return
    }
    case "set-range-numfmt": {
      const sheet = findSheet(doc, op.sheetId!)!
      const range = toRange(op.params.range)!
      const pattern = op.params.pattern as string | null
      for (let r = range.row; r <= range.row2; r++) {
        for (let c = range.column; c <= range.column2; c++) {
          const key = cellKey(r, c)
          const cell = sheet.cells[key] ?? {}
          if (pattern === null || pattern === "") delete cell.numfmt
          else cell.numfmt = pattern
          sheet.cells[key] = cell
        }
      }
      return
    }
    case "insert-sheet": {
      const id = op.params.sheetId as string
      const index = toInt(op.params.index)!
      const sheet: VSheet = {
        id,
        name: (op.params.name as string).trim(),
        rowCount: toInt(op.params.rowCount) ?? 100,
        columnCount: toInt(op.params.columnCount) ?? 26,
        cells: {},
        merges: [],
        filters: null,
        validations: [],
        conditionalFormats: [],
        rowHeights: {},
        colWidths: {},
        defaultRowHeight: 24,
        defaultColumnWidth: 88,
      }
      if (typeof op.params.tabColor === "string") sheet.tabColor = op.params.tabColor
      doc.sheets.splice(index, 0, sheet)
      return
    }
    case "remove-sheet": {
      doc.sheets = doc.sheets.filter((s) => s.id !== op.sheetId)
      doc.namedRanges = doc.namedRanges.filter((n) => n.sheetId !== op.sheetId)
      return
    }
    case "rename-sheet": {
      const sheet = findSheet(doc, op.sheetId!)!
      sheet.name = (op.params.name as string).trim()
      return
    }
    case "move-sheet": {
      const sheet = findSheet(doc, op.sheetId!)!
      const index = toInt(op.params.index)!
      const from = doc.sheets.indexOf(sheet)
      doc.sheets.splice(from, 1)
      doc.sheets.splice(index, 0, sheet)
      return
    }
    case "duplicate-sheet": {
      const sheet = findSheet(doc, op.sheetId!)!
      const copy: VSheet = JSON.parse(JSON.stringify(sheet))
      copy.id = op.params.newId as string
      copy.name = op.params.name ? (op.params.name as string) : `${sheet.name} (copy)`
      copy.cells = {}
      doc.sheets.splice(doc.sheets.indexOf(sheet) + 1, 0, copy)
      return
    }
    case "insert-rows": {
      const sheet = findSheet(doc, op.sheetId!)!
      const index = toInt(op.params.index)!
      const count = toInt(op.params.count)!
      sheet.rowCount += count
      const shifted: Record<string, VCell> = {}
      const heights: Record<string, number> = {}
      for (const [key, cell] of Object.entries(sheet.cells)) {
        const [r, c] = key.split("_").map(Number)
        if (r >= index) shifted[cellKey(r + count, c)] = cell
        else shifted[key] = cell
      }
      sheet.cells = shifted
      for (const [key, h] of Object.entries(sheet.rowHeights)) {
        const r = Number(key.split("_")[0])
        if (r >= index) heights[cellKey(r + count, 0)] = h
        else heights[key] = h
      }
      sheet.rowHeights = heights
      return
    }
    case "remove-rows": {
      const sheet = findSheet(doc, op.sheetId!)!
      const index = toInt(op.params.index)!
      const count = toInt(op.params.count)!
      const cells: Record<string, VCell> = {}
      for (const [key, cell] of Object.entries(sheet.cells)) {
        const [r, c] = key.split("_").map(Number)
        if (r >= index && r < index + count) continue
        cells[cellKey(r >= index + count ? r - count : r, c)] = cell
      }
      sheet.cells = cells
      sheet.rowCount = Math.max(1, sheet.rowCount - count)
      const heights: Record<string, number> = {}
      for (const [key, h] of Object.entries(sheet.rowHeights)) {
        const r = Number(key.split("_")[0])
        if (r >= index && r < index + count) continue
        heights[cellKey(r >= index + count ? r - count : r, 0)] = h
      }
      sheet.rowHeights = heights
      return
    }
    case "insert-cols": {
      const sheet = findSheet(doc, op.sheetId!)!
      const index = toInt(op.params.index)!
      const count = toInt(op.params.count)!
      sheet.columnCount += count
      const shifted: Record<string, VCell> = {}
      for (const [key, cell] of Object.entries(sheet.cells)) {
        const [r, c] = key.split("_").map(Number)
        shifted[cellKey(r, c >= index ? c + count : c)] = cell
      }
      sheet.cells = shifted
      const widths: Record<string, number> = {}
      for (const [key, w] of Object.entries(sheet.colWidths)) {
        const c = Number(key.split("_")[1])
        widths[cellKey(0, c >= index ? c + count : c)] = w
      }
      sheet.colWidths = widths
      return
    }
    case "remove-cols": {
      const sheet = findSheet(doc, op.sheetId!)!
      const index = toInt(op.params.index)!
      const count = toInt(op.params.count)!
      const cells: Record<string, VCell> = {}
      for (const [key, cell] of Object.entries(sheet.cells)) {
        const [r, c] = key.split("_").map(Number)
        if (c >= index && c < index + count) continue
        cells[cellKey(r, c >= index + count ? c - count : c)] = cell
      }
      sheet.cells = cells
      sheet.columnCount = Math.max(1, sheet.columnCount - count)
      const widths: Record<string, number> = {}
      for (const [key, w] of Object.entries(sheet.colWidths)) {
        const c = Number(key.split("_")[1])
        if (c >= index && c < index + count) continue
        widths[cellKey(0, c >= index + count ? c - count : c)] = w
      }
      sheet.colWidths = widths
      return
    }
    case "set-row-height": {
      const sheet = findSheet(doc, op.sheetId!)!
      const rows = op.params.rows as number[]
      const heights = op.params.heights as (number | null)[]
      for (let i = 0; i < rows.length; i++) {
        const h = heights[i]
        const value = typeof h === "number" && h > 0 ? h : null
        if (value === null) delete sheet.rowHeights[cellKey(rows[i], 0)]
        else sheet.rowHeights[cellKey(rows[i], 0)] = value
      }
      return
    }
    case "set-col-width": {
      const sheet = findSheet(doc, op.sheetId!)!
      const cols = op.params.cols as number[]
      const widths = op.params.widths as (number | null)[]
      for (let i = 0; i < cols.length; i++) {
        const w = widths[i]
        const value = typeof w === "number" && w > 0 ? w : null
        if (value === null) delete sheet.colWidths[cellKey(0, cols[i])]
        else sheet.colWidths[cellKey(0, cols[i])] = value
      }
      return
    }
    case "merge-cells": {
      const sheet = findSheet(doc, op.sheetId!)!
      const range = toRange(op.params.range)!
      if (!sheet.merges.some((m) => m.row === range.row && m.column === range.column && m.row2 === range.row2 && m.column2 === range.column2)) {
        sheet.merges.push(range)
      }
      return
    }
    case "unmerge-cells": {
      const sheet = findSheet(doc, op.sheetId!)!
      const range = toRange(op.params.range)!
      sheet.merges = sheet.merges.filter(
        (m) => !(m.row === range.row && m.column === range.column && m.row2 === range.row2 && m.column2 === range.column2)
      )
      return
    }
    case "set-filter": {
      const sheet = findSheet(doc, op.sheetId!)!
      sheet.filters = (op.params.filter as { range: { row: number; column: number; row2: number; column2: number } } | null) ?? null
      return
    }
    case "set-validation": {
      const sheet = findSheet(doc, op.sheetId!)!
      const id = op.params.id as string
      const rule = op.params.rule as Record<string, unknown> | null
      if (rule === null) sheet.validations = sheet.validations.filter((v) => v.id !== id)
      else {
        const found = sheet.validations.find((v) => v.id === id)
        if (found) Object.assign(found, rule)
        else sheet.validations.push({ id, ...rule })
      }
      return
    }
    case "set-conditional-format": {
      const sheet = findSheet(doc, op.sheetId!)!
      const id = op.params.id as string
      const cf = op.params.cf as Record<string, unknown> | null
      if (cf === null) sheet.conditionalFormats = sheet.conditionalFormats.filter((c) => c.id !== id)
      else {
        const found = sheet.conditionalFormats.find((c) => c.id === id)
        if (found) Object.assign(found, cf)
        else sheet.conditionalFormats.push({ id, ...cf })
      }
      return
    }
    case "set-named-range": {
      const id = op.params.id as string
      const range = toRange(op.params.range)
      const name = op.params.name as string
      if (range === null) doc.namedRanges = doc.namedRanges.filter((n) => n.id !== id)
      else {
        const found = doc.namedRanges.find((n) => n.id === id)
        if (found) {
          found.name = name
          found.sheetId = op.sheetId ?? found.sheetId
          found.range = range
        } else {
          doc.namedRanges.push({ id, name, sheetId: op.sheetId!, range })
        }
      }
      return
    }
    case "rename-workbook": {
      doc.name = (op.params.name as string).trim()
      return
    }
  }
}

// --- diff engine ------------------------------------------------------------

type Range = { row: number; column: number; row2: number; column2: number }

function eq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
}

function rangeKey(r: Range): string {
  return `${r.row}:${r.column}:${r.row2}:${r.column2}`
}

/**
 * Compute an op batch that turns `prev` into `next`. Ops are emitted in an
 * order the server accepts: sheet removals, additions + reorder, then
 * per-sheet content. Cleared cells that fell inside a removed row/col band
 * are skipped — the remove op already dropped them (and out-of-bounds ranges
 * would be rejected).
 */
export function diffVs1(prev: VDoc, next: VDoc): Op[] {
  const ops: Op[] = []

  if (prev.name !== next.name) ops.push({ cmd: "rename-workbook", params: { name: next.name } })

  const prevIds = prev.sheets.map((s) => s.id)
  const nextIds = next.sheets.map((s) => s.id)
  const prevById = new Map(prev.sheets.map((s) => [s.id, s]))
  const nextById = new Map(next.sheets.map((s) => [s.id, s]))

  // Removed sheets first (later ops must never reference them).
  for (const id of prevIds) {
    if (!nextById.has(id)) ops.push({ cmd: "remove-sheet", sheetId: id, params: {} })
  }

  // Added sheets — insert directly at their target index.
  for (let i = 0; i < nextIds.length; i++) {
    const id = nextIds[i]
    if (prevById.has(id)) continue
    const s = nextById.get(id)!
    ops.push({
      cmd: "insert-sheet",
      sheetId: id,
      params: { sheetId: id, name: s.name, index: i, rowCount: s.rowCount, columnCount: s.columnCount },
    })
  }

  // Reorder existing sheets to match `next` (stable move-to-index).
  const cur = nextIds.filter((id) => prevById.has(id))
  for (let i = 0; i < nextIds.length; i++) {
    const want = nextIds[i]
    const curIndex = cur.indexOf(want)
    if (curIndex === -1) continue
    if (curIndex !== i) {
      ops.push({ cmd: "move-sheet", sheetId: want, params: { index: i } })
      cur.splice(curIndex, 1)
      cur.splice(i, 0, want)
    }
  }

  // Per-sheet content diff.
  for (const id of nextIds) {
    const oldSheet = prevById.get(id)
    if (!oldSheet) continue
    const sheet = nextById.get(id)!
    diffSheet(ops, oldSheet, sheet)
  }

  return ops
}

function diffSheet(ops: Op[], prev: VSheet, next: VSheet): void {
  if (prev.name !== next.name) ops.push({ cmd: "rename-sheet", sheetId: next.id, params: { name: next.name } })

  // Dimension changes: only grow/shrink at the end of the axis. Content in a
  // removed band was deleted by the remove op, so the cell diff must not
  // re-clear it (those positions are out of bounds in the new doc).
  const removedRows = [next.rowCount, prev.rowCount] as const
  const removedCols = [next.columnCount, prev.columnCount] as const
  if (next.rowCount > prev.rowCount) {
    ops.push({ cmd: "insert-rows", sheetId: next.id, params: { index: prev.rowCount, count: next.rowCount - prev.rowCount } })
  } else if (next.rowCount < prev.rowCount) {
    ops.push({ cmd: "remove-rows", sheetId: next.id, params: { index: next.rowCount, count: prev.rowCount - next.rowCount } })
  }
  if (next.columnCount > prev.columnCount) {
    ops.push({ cmd: "insert-cols", sheetId: next.id, params: { index: prev.columnCount, count: next.columnCount - prev.columnCount } })
  } else if (next.columnCount < prev.columnCount) {
    ops.push({ cmd: "remove-cols", sheetId: next.id, params: { index: next.columnCount, count: prev.columnCount - next.columnCount } })
  }

  // Merges.
  const prevMerges = new Set(prev.merges.map(rangeKey))
  for (const m of next.merges) {
    if (!prevMerges.has(rangeKey(m))) ops.push({ cmd: "merge-cells", sheetId: next.id, params: { range: m } })
  }
  const nextMerges = new Set(next.merges.map(rangeKey))
  for (const m of prev.merges) {
    if (!nextMerges.has(rangeKey(m))) ops.push({ cmd: "unmerge-cells", sheetId: next.id, params: { range: m } })
  }

  // Row heights / col widths.
  const rowIds = new Set([...Object.keys(prev.rowHeights), ...Object.keys(next.rowHeights)])
  const changedRows: number[] = []
  const rowVals: (number | null)[] = []
  for (const key of rowIds) {
    const r = Number(key.split("_")[0])
    if (!Number.isInteger(r)) continue
    const a = prev.rowHeights[key]
    const b = next.rowHeights[key]
    if (!eq(a, b)) {
      changedRows.push(r)
      rowVals.push(typeof b === "number" && b > 0 ? b : null)
    }
  }
  if (changedRows.length) ops.push({ cmd: "set-row-height", sheetId: next.id, params: { rows: changedRows, heights: rowVals } })

  const colIds = new Set([...Object.keys(prev.colWidths), ...Object.keys(next.colWidths)])
  const changedCols: number[] = []
  const colVals: (number | null)[] = []
  for (const key of colIds) {
    const c = Number(key.split("_")[1])
    if (!Number.isInteger(c)) continue
    const a = prev.colWidths[key]
    const b = next.colWidths[key]
    if (!eq(a, b)) {
      changedCols.push(c)
      colVals.push(typeof b === "number" && b > 0 ? b : null)
    }
  }
  if (changedCols.length) ops.push({ cmd: "set-col-width", sheetId: next.id, params: { cols: changedCols, widths: colVals } })

  // Cells — classify every key where prev/next differ.
  interface CellChange<T = unknown> {
    r: number
    c: number
    payload: T
  }
  const valueChanges: CellChange<Record<string, unknown> | null>[] = []
  const styleChanges: CellChange<Record<string, unknown> | null>[] = []
  const numfmtChanges: CellChange<string | null>[] = []

  const allKeys = new Set([...Object.keys(prev.cells), ...Object.keys(next.cells)])
  for (const key of allKeys) {
    const [r, c] = key.split("_").map(Number)
    if (!Number.isInteger(r) || !Number.isInteger(c)) continue
    const inRemovedRow = r >= removedRows[0] && r < removedRows[1]
    const inRemovedCol = c >= removedCols[0] && c < removedCols[1]
    const old = prev.cells[key]
    const nextCell = next.cells[key]

    if (!nextCell || inRemovedRow || inRemovedCol) {
      // The position vanished: cleared in place, or dropped by a dim op.
      if (old && !inRemovedRow && !inRemovedCol) valueChanges.push({ r, c, payload: null })
      continue
    }
    if (!eq(old?.v, nextCell.v) || !eq(old?.f, nextCell.f) || !eq(old?.t, nextCell.t)) {
      const payload: Record<string, unknown> = {}
      if (nextCell.v !== undefined) payload.v = nextCell.v
      if (typeof nextCell.f === "string") payload.f = nextCell.f
      if (typeof nextCell.t === "number") payload.t = nextCell.t
      valueChanges.push({ r, c, payload })
    }
    if (!eq(old?.style, nextCell.style)) styleChanges.push({ r, c, payload: nextCell.style ?? null })
    if (!eq(old?.numfmt, nextCell.numfmt)) numfmtChanges.push({ r, c, payload: nextCell.numfmt ?? null })
  }

  // One op per contiguous run. Value runs keep per-cell payloads in a matrix;
  // style/numfmt runs require a uniform payload across the range.
  emitRuns(valueChanges, (cells) => ({
    cmd: "set-range-values",
    sheetId: next.id,
    params: { range: cells.range, values: cells.matrix },
  }), ops, false)
  emitRuns(styleChanges, (cells) => ({
    cmd: "set-range-style",
    sheetId: next.id,
    params: { range: cells.range, styles: cells.uniformPayload },
  }), ops, true)
  emitRuns(numfmtChanges, (cells) => ({
    cmd: "set-range-numfmt",
    sheetId: next.id,
    params: { range: cells.range, pattern: cells.uniformPayload },
  }), ops, true)
}

interface CellRun<T> {
  range: Range
  matrix?: unknown[][]
  uniformPayload?: T
}

/**
 * Group `changes` (row-major) into contiguous runs and emit one op per run.
 * Matrix runs (values) place each payload at its cell — absent -> null, which
 * the server interprets as "clear this cell". Uniform runs (style/numfmt)
 * additionally break when the payload changes so the range shares one value.
 */
function emitRuns<T>(
  changes: { r: number; c: number; payload: T }[],
  build: (run: CellRun<T>) => Op,
  ops: Op[],
  uniform: boolean
): void {
  if (!changes.length) return
  changes.sort((a, b) => a.r - b.r || a.c - b.c)

  let run = { startR: changes[0].r, startC: changes[0].c, endR: changes[0].r, endC: changes[0].c, payload: changes[0].payload }
  const rows: Map<number, Map<number, T>> = new Map()
  const put = (r: number, c: number, v: T) => {
    let row = rows.get(r)
    if (!row) {
      row = new Map()
      rows.set(r, row)
    }
    row.set(c, v)
  }
  put(run.startR, run.startC, run.payload)

  const flush = () => {
    if (uniform) {
      ops.push(build({ range: { row: run.startR, column: run.startC, row2: run.endR, column2: run.endC }, uniformPayload: run.payload }))
    } else {
      const matrix: unknown[][] = []
      for (let r = run.startR; r <= run.endR; r++) {
        const row = rows.get(r)
        const line: unknown[] = []
        for (let c = run.startC; c <= run.endC; c++) line.push(row?.get(c) ?? null)
        matrix.push(line)
      }
      ops.push(build({ range: { row: run.startR, column: run.startC, row2: run.endR, column2: run.endC }, matrix }))
    }
    rows.clear()
  }

  for (let i = 1; i < changes.length; i++) {
    const ch = changes[i]
    const sameRowNext = ch.r === run.endR && ch.c === run.endC + 1
    const samePayload = uniform && eq(ch.payload, run.payload)
    if (!sameRowNext || (uniform && !samePayload)) {
      flush()
      run = { startR: ch.r, startC: ch.c, endR: ch.r, endC: ch.c, payload: ch.payload }
    } else {
      run.endR = ch.r
      run.endC = ch.c
    }
    put(ch.r, ch.c, ch.payload)
  }
  flush()
}