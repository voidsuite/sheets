/**
 * Client-side models for Void Sheets — mirror of the gateway's DTOs,
 * plus the VS1 document type shared with the server's op engine.
 */

export interface User {
  id: string
  name: string
  email: string
  picture?: string | null
}

export type UserSummary = Pick<User, "id" | "name" | "picture">

export type WorkbookRole = "owner" | "editor" | "viewer"

export interface WorkbookMember {
  userId: string
  name: string
  email: string
  picture?: string | null
  role: "editor" | "viewer"
  joinedAt: number
}

export interface ShareLink {
  token: string
  role: "editor" | "viewer"
  enabled: boolean
  createdBy: string
  createdAt: number
}

export interface Workbook {
  id: string
  name: string
  owner: { id: string; name: string; picture?: string | null }
  vault: boolean
  /** The caller's role: owner | editor | viewer. */
  role: WorkbookRole
  members: WorkbookMember[]
  shareLinks: ShareLink[]
  createdAt: number
  updatedAt: number
}

// --- VS1 document (server-authoritative) -------------------------------------

export interface CellRef {
  row: number
  column: number
  row2: number
  column2: number
}

/** A cell value object. `v` may be a primitive; style/numfmt stay opaque. */
export interface VCell {
  v?: unknown
  f?: string
  /** Univer CellValueType: 1 string, 2 number, 3 boolean, 4 force-string. */
  t?: number
  numfmt?: string | null
  style?: Record<string, unknown> | null
  [key: string]: unknown
}

export interface VSheet {
  id: string
  name: string
  rowCount: number
  columnCount: number
  tabColor?: string | null
  cells: Record<string, VCell> // key `${row}_${column}`
  merges: CellRef[]
  filters?: { range: CellRef; [key: string]: unknown } | null
  validations: Record<string, unknown>[]
  conditionalFormats: Record<string, unknown>[]
  rowHeights: Record<string, number>
  colWidths: Record<string, number>
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

export const OP_COMMANDS = [
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
] as const

export type OpCommand = (typeof OP_COMMANDS)[number]

// --- Hydrate / collab payloads ------------------------------------------------

export interface HydratedSheet {
  sheet: Workbook
  vault: boolean
  doc?: VDoc
  version?: number
  maxUploadBytes?: number
}

export interface VersionMeta {
  id: string
  kind: "checkpoint" | "named"
  name: string | null
  authorId: string
  createdAt: number
}

export interface OpsEntry {
  seq: number
  op: Op
  actorId: string
  createdAt: number
}

export interface PresenceMember {
  userId: string
  name: string
  picture?: string | null
}

export interface WsEvent {
  type: string
  sheetId: string
  actorId?: string
  [key: string]: unknown
}

/** Generic add sheet payload — templates import a prebuilt VS1 doc. */
export interface TemplateDoc {
  name: string
  doc: VDoc
}