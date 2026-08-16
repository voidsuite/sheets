/**
 * OAuth 2.0 + PKCE helpers for the VoidAuth OIDC provider.
 * Endpoints mirror the VoidAuth server (/oauth/authorize, /oauth/token,
 * /oauth/userinfo, /oauth/revoke).
 */

import config from "../config.js"

export interface OAuthUser {
  id: string
  name: string
  email: string
  picture?: string
}

export interface OAuthTokens {
  accessToken: string
  refreshToken?: string
  idToken?: string
  expiresIn?: number
  scope?: string
  user?: OAuthUser
}

interface Discovery {
  authorization_endpoint: string
  token_endpoint: string
  userinfo_endpoint: string
  revocation_endpoint?: string
}

interface TokenResponse {
  access_token?: string
  refresh_token?: string
  id_token?: string
  expires_in?: number
  scope?: string
  user?: OAuthUser
  error?: string
  error_description?: string
}

interface UserInfoResponse {
  sub?: string
  id?: string
  name?: string
  preferred_username?: string
  email?: string
  picture?: string
}

const discoveryCache = new Map<string, Discovery>()
const USERINFO_CACHE = new Map<string, { user: OAuthUser; expires: number }>()

export async function fetchDiscovery(): Promise<Discovery> {
  const cached = discoveryCache.get(config.voidauthUrl)
  if (cached) return cached
  const res = await fetch(`${config.voidauthUrl}/.well-known/openid-configuration`)
  if (!res.ok) throw new Error(`VoidAuth discovery failed: ${res.status}`)
  const doc = (await res.json()) as Discovery
  discoveryCache.set(config.voidauthUrl, doc)
  return doc
}

export function generateRandomString(length: number): string {
  const arr = new Uint8Array(length)
  crypto.getRandomValues(arr)
  return Buffer.from(arr).toString("base64url")
}

export function sha256(input: string): string {
  const digest = Bun.CryptoHasher.hash("sha256", input, "base64")
  return digest.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

export function buildAuthorizeParams(scope = "openid profile email") {
  const verifier = generateRandomString(32)
  const challenge = sha256(verifier)
  const state = generateRandomString(16)
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: `${config.appUrl.replace(/\/+$/, "")}/oauth/callback`,
    response_type: "code",
    scope,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  })
  return { params, verifier, state }
}

export function authorizeUrl(params: URLSearchParams): string {
  return `${config.voidauthUrl}/oauth/authorize?${params.toString()}`
}

export async function exchangeCode(code: string, verifier: string): Promise<OAuthTokens> {
  const res = await fetch(`${config.voidauthUrl}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      redirect_uri: `${config.appUrl.replace(/\/+$/, "")}/oauth/callback`,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code_verifier: verifier,
    }),
  })
  const data = (await res.json()) as TokenResponse
  if (!res.ok) throw new Error(data?.error_description || data?.error || `Token exchange failed: ${res.status}`)
  return {
    accessToken: data.access_token || "",
    refreshToken: data.refresh_token,
    idToken: data.id_token,
    expiresIn: data.expires_in,
    scope: data.scope,
    user: data.user,
  }
}

export async function refreshTokens(refreshToken: string): Promise<OAuthTokens> {
  const res = await fetch(`${config.voidauthUrl}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: config.clientId,
      client_secret: config.clientSecret,
    }),
  })
  const data = (await res.json()) as TokenResponse
  if (!res.ok || !data.access_token) {
    throw new Error(data?.error_description || data?.error || `Token refresh failed: ${res.status}`)
  }
  return {
    accessToken: data.access_token || "",
    refreshToken: data.refresh_token || refreshToken,
    idToken: data.id_token,
    expiresIn: data.expires_in,
    scope: data.scope,
    user: data.user,
  }
}

export async function revokeToken(token: string): Promise<void> {
  if (!config.clientSecret) return
  await fetch(`${config.voidauthUrl}/oauth/revoke`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token,
      client_id: config.clientId,
      client_secret: config.clientSecret,
    }),
  }).catch(() => {})
}

/** Validate a bearer token against VoidAuth userinfo (cached ~2 min). */
export async function validateBearerToken(accessToken: string): Promise<OAuthUser> {
  const cached = USERINFO_CACHE.get(accessToken)
  if (cached && cached.expires > Date.now()) return cached.user

  const res = await fetch(`${config.voidauthUrl}/oauth/userinfo`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) throw new Error(`Token validation failed: ${res.status}`)
  const data = (await res.json()) as UserInfoResponse
  const user: OAuthUser = {
    id: data.sub || data.id || "",
    name: data.name || data.preferred_username || "",
    email: data.email || "",
    picture: data.picture,
  }
  USERINFO_CACHE.set(accessToken, { user, expires: Date.now() + 2 * 60 * 1000 })
  return user
}