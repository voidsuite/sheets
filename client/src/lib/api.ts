/**
 * Void Sheets API client — two auth backends:
 *
 *  - "backend" (default): OAuth PKCE proxied through the sheets gateway. The
 *    gateway issues an httpOnly session cookie; the browser never sees
 *    tokens. Recommended.
 *  - "browser": @voidauth/client browser SDK does PKCE directly against the
 *    VoidAuth server; the access token is sent to the gateway as a Bearer
 *    header and validated against VoidAuth userinfo.
 */

import type { HydratedSheet, Op, OpsEntry, User, VersionMeta, VDoc, Workbook } from "./types"

export type AuthMode = "backend" | "browser"

export const authMode: AuthMode = (import.meta.env.VITE_AUTH_MODE as AuthMode) || "backend"

export const gatewayBase = (import.meta.env.VITE_API_URL || "").replace(/\/+$/, "")
export const voidauthIssuer = (import.meta.env.VITE_VOIDAUTH_ISSUER || "https://auth.stwupid.tech").replace(/\/+$/, "")
export const voidauthClientId = import.meta.env.VITE_VOIDAUTH_CLIENT_ID || "sheets"

export class ApiError extends Error {
  status: number
  constructor(message: string, status = 500) {
    super(message)
    this.status = status
  }
}

async function readError(res: Response): Promise<string> {
  try {
    const data = await res.json()
    return data?.error || data?.error_description || `Request failed (${res.status})`
  } catch {
    return `Request failed (${res.status})`
  }
}

async function gateway<T>(path: string, options: RequestInit = {}, retry = true): Promise<T> {
  const res = await fetch(`${gatewayBase}${path}`, {
    ...options,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(options.headers as Record<string, string>),
    },
  })
  if (!res.ok) {
    if (res.status === 401 && retry) {
      const refreshed = await refreshSession()
      if (refreshed) return gateway<T>(path, options, false)
    }
    throw new ApiError(await readError(res), res.status)
  }
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

// --- Browser SDK (lazy singleton) ---

let sdkInstance: any = null

async function getSdk(): Promise<any> {
  if (sdkInstance) return sdkInstance
  const { VoidAuth } = await import("@voidauth/client/browser")
  sdkInstance = new VoidAuth({
    issuer: voidauthIssuer,
    clientId: voidauthClientId,
    redirectUri: `${window.location.origin}/oauth/callback`,
    scopes: ["openid", "profile", "email"],
  })
  return sdkInstance
}

// --- Auth ---

export async function startLogin(keepMeLoggedIn = true): Promise<void> {
  if (authMode === "browser") {
    const sdk = await getSdk()
    await sdk.login()
    return
  }
  sessionStorage.setItem("sheets_keep_me_logged_in", keepMeLoggedIn ? "1" : "0")
  const { authUrl } = await gateway<{ authUrl: string }>("/api/auth/login")
  const separator = authUrl.includes("?") ? "&" : "?"
  window.location.href = `${authUrl}${separator}keep_me_logged_in=${keepMeLoggedIn}`
}

export async function handleCallback(code: string, state: string, keepMeLoggedIn = true): Promise<User> {
  if (authMode === "browser") {
    const sdk = await getSdk()
    await sdk.handleCallback()
    const token = sdk.getToken()
    const { user: sessionUser } = await gateway<{ user: User }>("/api/auth/browser-session", {
      method: "POST",
      body: JSON.stringify({ accessToken: token }),
    })
    return sessionUser
  }
  const { user } = await gateway<{ user: User }>("/api/auth/exchange", {
    method: "POST",
    body: JSON.stringify({ code, state, keepMeLoggedIn }),
  })
  return user
}

export async function getMe(): Promise<User | null> {
  if (authMode === "browser") {
    const sdk = await getSdk()
    if (!sdk.isAuthenticated()) return null
    return sdk.getUser() || null
  }
  try {
    const { user } = await gateway<{ user: User }>("/api/auth/me")
    return user
  } catch {
    return null
  }
}

export async function refreshSession(): Promise<boolean> {
  try {
    const res = await fetch(`${gatewayBase}/api/auth/refresh`, { method: "POST", credentials: "include" })
    return res.ok
  } catch {
    return false
  }
}

export async function logout(): Promise<void> {
  if (authMode === "browser") {
    const sdk = await getSdk()
    await sdk.logout()
  }
  await gateway("/api/auth/logout", { method: "POST" }).catch(() => {})
}

// --- Workbooks ("My sheets") ---

export function listWorkbooks(): Promise<Workbook[]> {
  return gateway("/api/sheets")
}

export interface CreateWorkbookInput {
  name: string
  /** Optional prebuilt VS1 doc (templates + imports). */
  document?: VDoc
}

export function createWorkbook(input: CreateWorkbookInput): Promise<Workbook> {
  return gateway("/api/sheets", {
    method: "POST",
    body: JSON.stringify({ name: input.name, document: input.document ?? null }),
  })
}

export function renameWorkbook(id: string, name: string): Promise<Workbook> {
  return gateway(`/api/sheets/${id}`, { method: "PATCH", body: JSON.stringify({ name }) })
}

export function deleteWorkbook(id: string): Promise<void> {
  return gateway(`/api/sheets/${id}`, { method: "DELETE" })
}

export function getWorkbook(id: string): Promise<Workbook> {
  return gateway(`/api/sheets/${id}`)
}

/** Hydrate a workbook: metadata + VS1 doc (unless vaulted). */
export function hydrateSheet(id: string): Promise<HydratedSheet> {
  return gateway(`/api/sheets/${id}/document`)
}

export function joinByToken(token: string): Promise<Workbook> {
  return gateway(`/api/join/${token}`, { method: "POST" })
}

// --- Sharing ---

export function createShareLink(id: string, role: "viewer" | "editor"): Promise<Workbook> {
  return gateway(`/api/sheets/${id}/share`, { method: "POST", body: JSON.stringify({ role }) })
}

export function revokeShareLink(id: string, token: string): Promise<Workbook> {
  return gateway(`/api/sheets/${id}/share/${token}`, { method: "DELETE" })
}

export function setMemberRole(id: string, userId: string, role: "viewer" | "editor"): Promise<Workbook> {
  return gateway(`/api/sheets/${id}/members/${userId}`, { method: "PATCH", body: JSON.stringify({ role }) })
}

export function removeMember(id: string, userId: string): Promise<Workbook> {
  return gateway(`/api/sheets/${id}/members/${userId}`, { method: "DELETE" })
}

// --- Ops (collaboration write path) ---

export interface PostOpsResult {
  ok: boolean
  seqs: number[]
  version: number
}

export function postOps(id: string, ops: Op[]): Promise<PostOpsResult> {
  return gateway(`/api/sheets/${id}/ops`, { method: "POST", body: JSON.stringify({ ops }) })
}

export function getOpsSince(id: string, after: number): Promise<{ ops: OpsEntry[] }> {
  return gateway(`/api/sheets/${id}/ops?after=${after}`)
}

// --- Versions ---

export function listVersions(id: string): Promise<{ versions: VersionMeta[] }> {
  return gateway(`/api/sheets/${id}/versions`)
}

export function saveVersion(id: string, kind: "checkpoint" | "named", name?: string): Promise<{ ok: boolean; versions: VersionMeta[] }> {
  return gateway(`/api/sheets/${id}/versions`, {
    method: "POST",
    body: JSON.stringify({ kind, name: name ?? null }),
  })
}

export function restoreVersion(id: string, versionId: string): Promise<{ ok: boolean; version: number }> {
  return gateway(`/api/sheets/${id}/versions/restore`, {
    method: "POST",
    body: JSON.stringify({ versionId }),
  })
}

// --- Vault (E2E) ---

export function getVaultBlob(id: string): Promise<{ data: string; version: number }> {
  return gateway(`/api/sheets/${id}/vault`)
}

export function saveVaultBlob(id: string, data: string): Promise<{ ok: boolean; version: number }> {
  return gateway(`/api/sheets/${id}/vault`, { method: "POST", body: JSON.stringify({ data }) })
}

/** enable: uploads an already-encrypted blob; disable: sends the plaintext VS1 doc. */
export function toggleVault(id: string, enable: boolean, payload: { blob?: string; document?: VDoc }): Promise<{ ok: boolean }> {
  return gateway(`/api/sheets/${id}/vault/toggle`, {
    method: "POST",
    body: JSON.stringify({ enable, ...payload }),
  })
}

// --- Storage proxy (opaque client-side ciphertext + vault-key escrow) ---

export function storageGet(key: string): Promise<unknown> {
  return gateway(`/api/storage/data?key=${encodeURIComponent(key)}`)
}

export function storageSet(key: string, value: string): Promise<unknown> {
  return gateway("/api/storage/data", { method: "POST", body: JSON.stringify({ key, value }) })
}

export function storageDelete(key: string): Promise<unknown> {
  return gateway(`/api/storage/data?key=${encodeURIComponent(key)}`, { method: "DELETE" })
}

export async function vaultKeyUnlock(submitted?: string): Promise<{ vaultKey: string | null; adopted: boolean }> {
  return gateway("/api/storage/sheets/vault-key/unlock", {
    method: "POST",
    body: JSON.stringify({ vaultKey: submitted ?? null }),
  })
}

export async function vaultKeyStore(vaultKey: string): Promise<{ ok: boolean }> {
  return gateway("/api/storage/sheets/vault-key/store", {
    method: "POST",
    body: JSON.stringify({ vaultKey }),
  })
}

// --- Realtime ---

/** Connect to the sheet room. Resolves the open WebSocket. */
export function openSheetSocket(sheetId: string): WebSocket {
  const proto = window.location.protocol === "https:" ? "wss" : "ws"
  const base = gatewayBase || `${proto}://${window.location.host}`
  const wsUrl = base.replace(/^http/, "ws")
  return new WebSocket(`${wsUrl}/api/ws?sheetId=${encodeURIComponent(sheetId)}`)
}