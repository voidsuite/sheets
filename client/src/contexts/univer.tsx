/**
 * Univer context — exposes the running engine + workbook/document state to
 * the sheet page and its chrome (toolbar, status bar, dialogs).
 */

import * as React from "react"
import type { VDoc, Workbook } from "@/lib/types"
import type { UniverRuntime } from "@/lib/univer-factory"

interface SheetContextValue {
  runtime: UniverRuntime | null
  wb: Workbook | null
  doc: VDoc | null
  version: number
  role: Workbook["role"]
  editable: boolean
  undo: () => Promise<void>
  redo: () => Promise<void>
}

const SheetContext = React.createContext<SheetContextValue | undefined>(undefined)

export function SheetProvider({
  runtime,
  wb,
  doc,
  version,
  children,
}: {
  runtime: UniverRuntime | null
  wb: Workbook | null
  doc: VDoc | null
  version: number
  children: React.ReactNode
}) {
  const undo = React.useCallback(async () => {
    await runtime?.univerAPI.undo()
  }, [runtime])
  const redo = React.useCallback(async () => {
    await runtime?.univerAPI.redo()
  }, [runtime])

  const role = wb?.role ?? "owner"
  const value = React.useMemo<SheetContextValue>(
    () => ({
      runtime,
      wb,
      doc,
      version,
      role,
      editable: role === "owner" || role === "editor",
      undo,
      redo,
    }),
    [runtime, wb, doc, version, role, undo, redo]
  )

  return <SheetContext.Provider value={value}>{children}</SheetContext.Provider>
}

export function useSheet(): SheetContextValue {
  const context = React.useContext(SheetContext)
  if (!context) throw new Error("useSheet must be used within a SheetProvider")
  return context
}