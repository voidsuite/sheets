/**
 * Realtime event bus — rooms by workbook id. The gateway broadcasts
 * server-authoritative events to peers; the client reconciles by applying
 * ops / replacing entities by id (idempotent), so echoes to the sender are
 * harmless.
 */

import type { ServerWebSocket } from "bun"

export interface ConnMeta {
  userId: string
  userName: string
  userPicture?: string | null
  workbookId?: string
}

const rooms = new Map<string, Set<ServerWebSocket<ConnMeta>>>()

function room(name: string): Set<ServerWebSocket<ConnMeta>> {
  let set = rooms.get(name)
  if (!set) {
    set = new Set()
    rooms.set(name, set)
  }
  return set
}

function roomNames(meta: ConnMeta): string[] {
  const names: string[] = []
  if (meta.workbookId) names.push(`sheet:${meta.workbookId}`)
  return names
}

export function addToRooms(ws: ServerWebSocket<ConnMeta>): void {
  for (const name of roomNames(ws.data)) room(name).add(ws)
}

export function removeFromRooms(ws: ServerWebSocket<ConnMeta>): void {
  for (const name of roomNames(ws.data)) {
    const set = rooms.get(name)
    if (set) {
      set.delete(ws)
      if (set.size === 0) rooms.delete(name)
    }
  }
}

/** Serialized members online in a namespace (deduped by user). */
export function onlineMembers(namespace: string): { userId: string; name: string; picture?: string | null }[] {
  const set = rooms.get(namespace)
  if (!set) return []
  const seen = new Map<string, { userId: string; name: string; picture?: string | null }>()
  for (const ws of set) {
    const m = ws.data
    if (!seen.has(m.userId)) seen.set(m.userId, { userId: m.userId, name: m.userName, picture: m.userPicture })
  }
  return [...seen.values()]
}

export function broadcast(namespace: string, payload: unknown, except?: ServerWebSocket<ConnMeta>): void {
  const set = rooms.get(namespace)
  if (!set) return
  const data = JSON.stringify(payload)
  for (const ws of set) {
    if (ws === except) continue
    try {
      ws.send(data)
    } catch {
      /* peer closing */
    }
  }
}

export function broadcastToSheet(workbookId: string, payload: unknown): void {
  broadcast(`sheet:${workbookId}`, payload)
}