/**
 * ID + ordering helpers.
 */

import { randomUUID } from "node:crypto"

/** Short random id (12 hex chars via subprocess-free randomUUID). */
export function newId(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 12)}`
}

export function newToken(length = 32): string {
  const arr = new Uint8Array(length)
  crypto.getRandomValues(arr)
  return Buffer.from(arr).toString("base64url")
}

export function generateShareToken(): string {
  return newToken(24)
}

/**
 * Fractional-index-free ordering: appending helpers just take the current
 * max+1. We reindex whole parents on move instead (see reindex helpers), so
 * this is just a convenience for appending.
 */
export function nextPosition(existing: number[]): number {
  return existing.length ? Math.max(...existing) + 1 : 0
}