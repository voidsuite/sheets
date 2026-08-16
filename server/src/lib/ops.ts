/**
 * Op engine for Void Sheets.
 *
 * The server keeps an authoritative "VS1" document (a normalized, versioned
 * JSON shape defined below) and applies a whitelisted, validated set of ops
 * to it. The client transposes VS1 <-> its own Univer snapshot; the server
 * treats cell value / style payloads as opaque JSON — it only manipulates
 * container structure (sheets, cells, ranges, dimensions), never the
 * semantics of style/number-format objects. That keeps the server robust to
 * Univer's schema and makes the doc stable enough to snapshot for version
 * history and to replay for catch-up.
 */

export interface CellRef {
  row: number
  column: number
  row2: number
  column2: number
}

export interface VCell {
  v?: unknown
  f?: string
  t?: string
  numfmt?: string | null
  style?: Record<string, unknown> | null
  [key: string]: unknown
}

/** A single sheet inside the VS1 document. */
export interface VSheet {
  id: string
  name: string
  rowCount: number
  columnCount: number
  tabColor?: string | null
  cells: Record<string, VCell> // key `${row}_${column}`
  merges: CellRef[]
  filters?: { range: CellRef; [key: string]: unknown } | null
  validations: Record<string, unknown>[] // opaque rules, id inside
  conditionalFormats: Record<string, unknown>[] // opaque rules, id inside
  rowHeights: Record<string, number> // key `${row}`
  colWidths: Record<string, number> // key `${col}`
  defaultRowHeight?: number
  defaultColumnWidth?: number
}

export interface VDoc {
  version: 1
  name: string
  sheets: VSheet[]
  namedRanges: { id: string; name: string; sheetId: string; range: CellRef }[]
  [key: string]: unknown
}

export interface Op {
  cmd: string
  sheetId?: string
  params: Record<string, unknown>
}

const MAX_CELLS_PER_BATCH = 50_000
const MAX_SHEETS = 200
const MAX_RANGE_DIM = 10_000
export const MAX_OP_BATCH = 200

export const OP_COMMANDS = new Set([
  "set-range-values",
  "set-range-style",
  "set-range-numfmt",
  "insert-sheet",
  "remove-sheet",
  "rename-sheet",
  "move-sheet",
  "duplicate-sheet",
  "insert-rows",
  "remove-rows",
  "insert-cols",
  "remove-cols",
  "set-row-height",
  "set-col-width",
  "merge-cells",
  "unmerge-cells",
  "set-filter",
  "set-validation",
  "set-conditional-format",
  "set-named-range",
  "rename-workbook",
])

// --- doc helpers -----------------------------------------------------------

export function blankSheet(id: string, name: string, rowCount = 100, columnCount = 26): VSheet {
  return {
    id,
    name,
    rowCount,
    columnCount,
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
}

export function blankDoc(name: string): VDoc {
  return {
    version: 1,
    name,
    sheets: [blankSheet("sheet-1", "Sheet1")],
    namedRanges: [],
  }
}

function findSheet(doc: VDoc, sheetId: string): VSheet | null {
  return doc.sheets.find((s) => s.id === sheetId) ?? null
}

function cellKey(r: number, c: number): string {
  return `${r}_${c}`
}

function toInt(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null
}

function toRange(v: unknown): CellRef | null {
  if (!v || typeof v !== "object") return null
  const o = v as Record<string, unknown>
  const row = toInt(o.row)
  const column = toInt(o.column)
  const row2 = toInt(o.row2)
  const column2 = toInt(o.column2)
  if (row === null || column === null || row2 === null || column2 === null) return null
  if (row2 < row || column2 < column) return null
  if (row2 - row > MAX_RANGE_DIM || column2 - column > MAX_RANGE_DIM) return null
  return { row, column, row2, column2 }
}

function inBounds(sheet: VSheet, range: CellRef): boolean {
  return range.row2 < sheet.rowCount && range.column2 < sheet.columnCount
}

/** Deep-cleanse a cell payload from undefined/null keys before storing. */
function cleanCell(raw: unknown): VCell | null {
  if (raw === null || raw === undefined) return null
  if (typeof raw !== "object") return { v: raw }
  const out: VCell = {}
  for (const [k, val] of Object.entries(raw as Record<string, unknown>)) {
    if (val !== null && val !== undefined) out[k] = val
  }
  return Object.keys(out).length ? out : null
}

// --- validation ------------------------------------------------------------

/**
 * Validate an op against the doc. Returns an error message or null.
 * Mutates nothing.
 */
export function validateOp(doc: VDoc, op: Op): string | null {
  if (!OP_COMMANDS.has(op.cmd)) return `Unknown op: ${op.cmd}`

  switch (op.cmd) {
    case "set-range-values": {
      const range = toRange(op.params.range)
      const sheet = op.sheetId ? findSheet(doc, op.sheetId) : null
      if (!op.sheetId || !sheet) return "Unknown sheet"
      if (!range) return "Invalid range"
      if (!inBounds(sheet, range)) return "Range out of bounds"
      const values = op.params.values
      if (!Array.isArray(values)) return "Missing values"
      const rows = range.row2 - range.row + 1
      const cols = range.column2 - range.column + 1
      if (values.length !== rows) return "Values row count mismatch"
      if (rows * cols > MAX_CELLS_PER_BATCH) return "Batch too large"
      for (const r of values) {
        if (!Array.isArray(r) || r.length !== cols) return "Values column count mismatch"
      }
      return null
    }
    case "set-range-style":
    case "set-range-numfmt": {
      const range = toRange(op.params.range)
      const sheet = op.sheetId ? findSheet(doc, op.sheetId) : null
      if (!op.sheetId || !sheet) return "Unknown sheet"
      if (!range) return "Invalid range"
      if (!inBounds(sheet, range)) return "Range out of bounds"
      if ((range.row2 - range.row + 1) * (range.column2 - range.column + 1) > MAX_CELLS_PER_BATCH) return "Batch too large"
      if (op.cmd === "set-range-style" && op.params.styles !== null && typeof op.params.styles !== "object") return "Invalid styles"
      return null
    }
    case "insert-sheet": {
      const id = typeof op.params.sheetId === "string" ? op.params.sheetId : ""
      if (!id || findSheet(doc, id)) return "Invalid or duplicate sheet id"
      if (doc.sheets.length >= MAX_SHEETS) return "Too many sheets"
      if (typeof op.params.name !== "string" || !op.params.name.trim()) return "Invalid sheet name"
      const index = toInt(op.params.index)
      if (index === null || index > doc.sheets.length) return "Invalid index"
      return null
    }
    case "remove-sheet": {
      const sheet = op.sheetId ? findSheet(doc, op.sheetId) : null
      if (!sheet) return "Unknown sheet"
      if (doc.sheets.length <= 1) return "Cannot remove the last sheet"
      return null
    }
    case "rename-sheet": {
      const sheet = op.sheetId ? findSheet(doc, op.sheetId) : null
      if (!sheet) return "Unknown sheet"
      if (typeof op.params.name !== "string" || !op.params.name.trim() || op.params.name.length > 100) return "Invalid sheet name"
      return null
    }
    case "move-sheet": {
      if (!op.sheetId || !findSheet(doc, op.sheetId)) return "Unknown sheet"
      const index = toInt(op.params.index)
      if (index === null || index >= doc.sheets.length) return "Invalid index"
      return null
    }
    case "duplicate-sheet": {
      const sheet = op.sheetId ? findSheet(doc, op.sheetId) : null
      if (!sheet) return "Unknown sheet"
      const newId = typeof op.params.newId === "string" ? op.params.newId : ""
      if (!newId || findSheet(doc, newId)) return "Invalid duplicate id"
      return null
    }
    case "insert-rows":
    case "insert-cols": {
      const sheet = op.sheetId ? findSheet(doc, op.sheetId) : null
      if (!sheet) return "Unknown sheet"
      const index = toInt(op.params.index)
      const count = toInt(op.params.count)
      if (index === null || count === null || count < 1 || count > 1000) return "Invalid insert params"
      if (op.cmd === "insert-rows" && index > sheet.rowCount) return "Invalid index"
      if (op.cmd === "insert-cols" && index > sheet.columnCount) return "Invalid index"
      return null
    }
    case "remove-rows":
    case "remove-cols": {
      const sheet = op.sheetId ? findSheet(doc, op.sheetId) : null
      if (!sheet) return "Unknown sheet"
      const index = toInt(op.params.index)
      const count = toInt(op.params.count)
      if (index === null || count === null || count < 1 || count > 1000) return "Invalid remove params"
      if (op.cmd === "remove-rows" && index + count > sheet.rowCount) return "Invalid range"
      if (op.cmd === "remove-cols" && index + count > sheet.columnCount) return "Invalid range"
      return null
    }
    case "set-row-height":
    case "set-col-width": {
      const sheet = op.sheetId ? findSheet(doc, op.sheetId) : null
      if (!sheet) return "Unknown sheet"
      const rows = op.params.rows
      const cols = op.params.cols
      const arr = op.cmd === "set-row-height" ? rows : cols
      const vals = op.params.heights ?? op.params.widths
      if (!Array.isArray(arr) || !Array.isArray(vals) || arr.length !== vals.length || arr.length > 10_000) return "Invalid params"
      return null
    }
    case "merge-cells":
    case "unmerge-cells": {
      const range = toRange(op.params.range)
      const sheet = op.sheetId ? findSheet(doc, op.sheetId) : null
      if (!op.sheetId || !sheet) return "Unknown sheet"
      if (!range) return "Invalid range"
      if (!inBounds(sheet, range)) return "Range out of bounds"
      return null
    }
    case "set-filter": {
      if (!op.sheetId || !findSheet(doc, op.sheetId)) return "Unknown sheet"
      if (op.params.filter !== null && (typeof op.params.filter !== "object" || op.params.filter === null)) return "Invalid filter"
      return null
    }
    case "set-validation": {
      if (!op.sheetId || !findSheet(doc, op.sheetId)) return "Unknown sheet"
      const id = typeof op.params.id === "string" ? op.params.id : ""
      if (!id) return "Invalid validation id"
      return null
    }
    case "set-conditional-format": {
      if (!op.sheetId || !findSheet(doc, op.sheetId)) return "Unknown sheet"
      const id = typeof op.params.id === "string" ? op.params.id : ""
      if (!id) return "Invalid conditional format id"
      return null
    }
    case "set-named-range": {
      const id = typeof op.params.id === "string" ? op.params.id : ""
      if (!id) return "Invalid named range id"
      const name = typeof op.params.name === "string" ? op.params.name : ""
      if (!name || !/^[A-Za-z_][A-Za-z0-9_.]*$/.test(name)) return "Invalid name"
      if (op.params.range !== null && !toRange(op.params.range)) return "Invalid range"
      if (op.params.range !== null && !op.params.sheetId) return "Missing sheet"
      return null
    }
    case "rename-workbook": {
      if (typeof op.params.name !== "string" || !op.params.name.trim() || op.params.name.length > 200) return "Invalid name"
      return null
    }
    default:
      return "Unhandled op"
  }
}

// --- application (mutates doc; assumes validateOp passed) --------------------

export function applyOp(doc: VDoc, op: Op): void {
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
      const sheet = blankSheet(id, (op.params.name as string).trim(), toInt(op.params.rowCount) ?? 100, toInt(op.params.columnCount) ?? 26)
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
      copy.cells = {} // cells are cloned below with sheetId-scoped ranges if provided
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
        const r = Number(key)
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
        const r = Number(key)
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
        const c = Number(key)
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
        const c = Number(key)
        if (c >= index && c < index + count) continue
        widths[cellKey(0, c >= index + count ? c - count : c)] = w
      }
      sheet.colWidths = widths
      return
    }
    case "set-row-height": {
      const sheet = findSheet(doc, op.sheetId!)!
      const rows = op.params.rows as number[]
      const heights = op.params.heights as number[]
      for (let i = 0; i < rows.length; i++) {
        const value = typeof heights[i] === "number" && heights[i] > 0 ? heights[i] : null
        if (value === null) delete sheet.rowHeights[cellKey(rows[i], 0)]
        else sheet.rowHeights[cellKey(rows[i], 0)] = value
      }
      return
    }
    case "set-col-width": {
      const sheet = findSheet(doc, op.sheetId!)!
      const cols = op.params.cols as number[]
      const widths = op.params.widths as number[]
      for (let i = 0; i < cols.length; i++) {
        const value = typeof widths[i] === "number" && widths[i] > 0 ? widths[i] : null
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
      sheet.filters = (op.params.filter as { range: CellRef } | null) ?? null
      return
    }
    case "set-validation": {
      const sheet = findSheet(doc, op.sheetId!)!
      const id = op.params.id as string
      const rule = op.params.rule as Record<string, unknown> | null
      if (rule === null) {
        sheet.validations = sheet.validations.filter((v) => v.id !== id)
      } else {
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
      if (cf === null) {
        sheet.conditionalFormats = sheet.conditionalFormats.filter((c) => c.id !== id)
      } else {
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
      if (range === null) {
        doc.namedRanges = doc.namedRanges.filter((n) => n.id !== id)
      } else {
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

/** Validate + apply a batch in order. Returns an error message or null. */
export function applyOps(doc: VDoc, ops: Op[]): string | null {
  for (const op of ops) {
    const err = validateOp(doc, op)
    if (err) return err
    applyOp(doc, op)
  }
  return null
}