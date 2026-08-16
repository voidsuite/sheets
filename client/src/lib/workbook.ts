/**
 * VS1 <-> Univer snapshot converter.
 *
 * The server keeps a normalized VS1 document (see server/src/lib/ops.ts);
 * the client renders it inside Univer, which needs an `IWorkbookData`
 * snapshot. Conversion only touches the parts we own the semantics of —
 * cells, formulas, inline styles, merges, dimensions, sheet list. Number
 * formats, filters, validations, conditional formats and named ranges are
 * carried through VS1 unchanged (opaque) and re-applied from the UI/ops in
 * later milestones; nothing is ever lost because VS1 stays authoritative.
 */

import { BooleanNumber, CellValueType, LocaleType } from "@univerjs/core"
import type { ICellData, IWorkbookData, IWorksheetData } from "@univerjs/core"
import type { CellRef, VCell, VDoc, VSheet } from "./types"

/** The Univer model-version string stamped on snapshots we build. */
const APP_VERSION = "0.5.0"

function cellKey(r: number, c: number): string {
  return `${r}_${c}`
}

/** Convert a VS1 merge range to Univer's IRange. */
function toUniverRange(ref: CellRef): { startRow: number; startColumn: number; endRow: number; endColumn: number } {
  return { startRow: ref.row, startColumn: ref.column, endRow: ref.row2, endColumn: ref.column2 }
}

/** Map a VS1 cell into Univer ICellData. Style objects travel inline. */
function toUniverCell(cell: VCell): ICellData {
  const out: ICellData = {}
  if (cell.v !== undefined) out.v = cell.v as string | number | boolean
  if (typeof cell.f === "string") out.f = cell.f
  if (typeof cell.t === "number") out.t = cell.t as CellValueType
  if (cell.style && typeof cell.style === "object" && Object.keys(cell.style).length) {
    out.s = cell.style as never
  }
  return out
}

function toVs1Cell(cell: ICellData | null | undefined, styles?: IWorkbookData["styles"]): VCell | null {
  if (!cell) return null
  const out: VCell = {}
  if (cell.v !== undefined) out.v = cell.v as string | number | boolean
  if (typeof cell.f === "string") out.f = cell.f
  if (cell.t !== undefined && cell.t !== null) out.t = cell.t as number
  if (cell.s) {
    const style = typeof cell.s === "string" ? styles?.[cell.s] : (cell.s as Record<string, unknown>)
    if (style && typeof style === "object" && Object.keys(style).length) out.style = style as Record<string, unknown>
  }
  return Object.keys(out).length ? out : null
}

/**
 * VS1 -> Univer snapshot. Used to hydrate the grid from the server doc
 * (and to paint remote ops / restored versions later).
 */
export function vs1ToSnapshot(doc: VDoc, unitId: string): IWorkbookData {
  const sheets: IWorkbookData["sheets"] = {}
  const sheetOrder: string[] = []

  for (const vs of doc.sheets) {
    const worksheet: IWorksheetData = {
      id: vs.id,
      name: vs.name,
      tabColor: vs.tabColor || "",
      hidden: BooleanNumber.FALSE,
      freeze: { xSplit: 0, ySplit: 0, startRow: 0, startColumn: 0 },
      rowCount: vs.rowCount,
      columnCount: vs.columnCount,
      zoomRatio: 1,
      scrollTop: 0,
      scrollLeft: 0,
      defaultColumnWidth: vs.defaultColumnWidth ?? 88,
      defaultRowHeight: vs.defaultRowHeight ?? 24,
      cellData: {},
      rowData: {},
      columnData: {},
      mergeData: [],
      rowHeader: { width: 46 },
      columnHeader: { height: 20 },
      showGridlines: BooleanNumber.TRUE,
      rightToLeft: BooleanNumber.FALSE,
    }

    // Cells
    const cellData: NonNullable<IWorksheetData["cellData"]> = {}
    for (const [key, cell] of Object.entries(vs.cells)) {
      const [r, c] = key.split("_").map(Number)
      if (!Number.isInteger(r) || !Number.isInteger(c)) continue
      const ic = toUniverCell(cell)
      if (!Object.keys(ic).length) continue
      ;(cellData[r] ??= {})[c] = ic
    }
    worksheet.cellData = cellData

    // Merges
    worksheet.mergeData = vs.merges.map(toUniverRange)

    // Row heights / col widths — VS1 keys are `${row}_0` / `0_${col}` (the
    // server's canonical shape); strip the column/row part here.
    const rowData: NonNullable<IWorksheetData["rowData"]> = {}
    for (const [key, h] of Object.entries(vs.rowHeights)) {
      const r = Number(String(key).split("_")[0])
      if (Number.isInteger(r) && typeof h === "number" && h > 0) rowData[r] = { h }
    }
    worksheet.rowData = rowData
    const columnData: NonNullable<IWorksheetData["columnData"]> = {}
    for (const [key, w] of Object.entries(vs.colWidths)) {
      const c = Number(String(key).split("_")[1])
      if (Number.isInteger(c) && typeof w === "number" && w > 0) columnData[c] = { w }
    }
    worksheet.columnData = columnData

    sheets[vs.id] = worksheet
    sheetOrder.push(vs.id)
  }

  return {
    id: unitId,
    name: doc.name,
    appVersion: APP_VERSION,
    locale: LocaleType.EN_US,
    styles: {},
    sheetOrder,
    sheets,
  }
}

/**
 * Univer snapshot -> VS1. Used when a workbook is toggled into Vault mode
 * (client must hand the server a VS1 doc) and for checkpoint snapshots.
 * Plugin-owned data (filters/validations/CF/named ranges/numfmt) is
 * intentionally not reverse-engineered here.
 */
export function snapshotToVs1(snapshot: IWorkbookData): VDoc {
  const sheets: VSheet[] = []
  const styles = snapshot.styles ?? {}

  for (const sheetId of snapshot.sheetOrder ?? []) {
    const ws = snapshot.sheets?.[sheetId] as IWorksheetData | undefined
    if (!ws) continue

    const cells: Record<string, VCell> = {}
    const cellData = ws.cellData ?? {}
    for (const rStr of Object.keys(cellData)) {
      const r = Number(rStr)
      if (!Number.isInteger(r)) continue
      const row = cellData[r]
      if (!row) continue
      for (const cStr of Object.keys(row)) {
        const c = Number(cStr)
        if (!Number.isInteger(c)) continue
        const vc = toVs1Cell(row[c], styles)
        if (vc) cells[cellKey(r, c)] = vc
      }
    }

    const merges: CellRef[] = (ws.mergeData ?? []).map((m) => ({
      row: m.startRow,
      column: m.startColumn,
      row2: m.endRow,
      column2: m.endColumn,
    }))

    const rowHeights: Record<string, number> = {}
    for (const [rStr, rd] of Object.entries(ws.rowData ?? {})) {
      const r = Number(rStr)
      if (Number.isInteger(r) && typeof rd?.h === "number" && rd.h > 0) rowHeights[cellKey(r, 0)] = rd.h
    }
    const colWidths: Record<string, number> = {}
    for (const [cStr, cd] of Object.entries(ws.columnData ?? {})) {
      const c = Number(cStr)
      if (Number.isInteger(c) && typeof cd?.w === "number" && cd.w > 0) colWidths[cellKey(0, c)] = cd.w
    }

    sheets.push({
      id: ws.id ?? sheetId,
      name: ws.name ?? "Sheet1",
      rowCount: ws.rowCount ?? 100,
      columnCount: ws.columnCount ?? 26,
      tabColor: ws.tabColor || null,
      cells,
      merges,
      filters: null,
      validations: [],
      conditionalFormats: [],
      rowHeights,
      colWidths,
      defaultRowHeight: ws.defaultRowHeight,
      defaultColumnWidth: ws.defaultColumnWidth,
    })
  }

  return {
    version: 1,
    name: snapshot.name ?? "Untitled",
    sheets,
    namedRanges: [],
  }
}

/** Fresh blank VS1 doc matching the server's blank doc. */
export function blankVs1(name: string): VDoc {
  return {
    version: 1,
    name,
    sheets: [
      {
        id: "sheet-1",
        name: "Sheet1",
        rowCount: 100,
        columnCount: 26,
        cells: {},
        merges: [],
        filters: null,
        validations: [],
        conditionalFormats: [],
        rowHeights: {},
        colWidths: {},
        defaultRowHeight: 24,
        defaultColumnWidth: 88,
      },
    ],
    namedRanges: [],
  }
}
