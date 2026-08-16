/**
 * Univer context — exposes the running engine + workbook/document state and
 * the live collaboration session to the sheet page and its chrome (toolbar,
 * status bar, dialogs, presence avatars).
 */

import * as React from "react"
import { CollabSession, type CollabStatus, type CursorInfo } from "@/lib/collab"
import type { PresenceMember, VDoc, Workbook } from "@/lib/types"
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
  /** Live collaboration session (null until the engine has booted). */
  collab: CollabSession | null
  collabStatus: CollabStatus
  collabPresence: PresenceMember[]
  collabCursors: Map<string, CursorInfo>
}

const SheetContext = React.createContext<SheetContextValue | undefined>(undefined)

export function SheetProvider({
  runtime,
  wb,
  doc,
  version,
  user,
  children,
}: {
  runtime: UniverRuntime | null
  wb: Workbook | null
  doc: VDoc | null
  version: number
  /** Current signed-in user (owns cursor + presence identity). */
  user: { id: string; name: string; picture?: string | null } | null
  children: React.ReactNode
}) {
  const undo = React.useCallback(async () => {
    await runtime?.univerAPI.undo()
  }, [runtime])
  const redo = React.useCallback(async () => {
    await runtime?.univerAPI.redo()
  }, [runtime])

  const [collab, setCollab] = React.useState<CollabSession | null>(null)
  const [collabStatus, setCollabStatus] = React.useState<CollabStatus>("connecting")
  const [collabPresence, setCollabPresence] = React.useState<PresenceMember[]>([])
  const [collabCursors, setCollabCursors] = React.useState<Map<string, CursorInfo>>(() => new Map())

  const role = wb?.role ?? "owner"
  const editable = role === "owner" || role === "editor"

  // Boot the collab session once we have an engine + doc. The session owns
  // the server-authoritative mirror and drives remote ops onto the grid.
  React.useEffect(() => {
    if (!runtime || !wb || !doc || wb.vault) {
      setCollab(null)
      return
    }
    const session = new CollabSession({
      runtime,
      sheetId: wb.id,
      editable,
      user: user ?? { id: wb.owner.id, name: wb.owner.name, picture: wb.owner.picture },
      initialDoc: doc,
      initialVersion: version,
      events: {
        onStatus: setCollabStatus,
        onPresence: setCollabPresence,
        onCursors: (cursors) => setCollabCursors(new Map(cursors)),
      },
    })
    session.start()
    session.enableCursors()
    setCollab(session)
    setCollabStatus("connecting")
    return () => {
      session.dispose()
      setCollab(null)
      setCollabPresence([])
      setCollabCursors(new Map())
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtime, wb?.id, doc, version])

  const value = React.useMemo<SheetContextValue>(
    () => ({
      runtime,
      wb,
      doc,
      version,
      role,
      editable,
      undo,
      redo,
      collab,
      collabStatus,
      collabPresence,
      collabCursors,
    }),
    [runtime, wb, doc, version, role, editable, undo, redo, collab, collabStatus, collabPresence, collabCursors]
  )

  return <SheetContext.Provider value={value}>{children}</SheetContext.Provider>
}

export function useSheet(): SheetContextValue {
  const context = React.useContext(SheetContext)
  if (!context) throw new Error("useSheet must be used within a SheetProvider")
  return context
}