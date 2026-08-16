/**
 * Auth context for Void Sheets.
 *
 * Login is always "Sign in with VoidAuth" — the app is server-authoritative,
 * everything syncs with your account, and there is no local-only mode.
 *
 *  - backend (default): the gateway proxies OAuth PKCE and issues an httpOnly
 *    session cookie.
 *  - browser: @voidauth/client does PKCE against the VoidAuth server; the
 *    gateway validates the token and creates the session.
 */

import * as React from "react"
import * as api from "@/lib/api"
import type { User } from "@/lib/types"

type AuthStatus = "loading" | "ready"

interface AuthContextValue {
  status: AuthStatus
  user: User | null
  mode: api.AuthMode
  signIn: (keepMeLoggedIn?: boolean) => Promise<void>
  signOut: () => Promise<void>
  /** Called by the OAuth callback route. */
  completeCallback: () => Promise<User>
  refresh: () => Promise<void>
}

const AuthContext = React.createContext<AuthContextValue | undefined>(undefined)

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const mode = api.authMode
  const [status, setStatus] = React.useState<AuthStatus>("loading")
  const [user, setUser] = React.useState<User | null>(null)

  // Restore an existing session on load. The OAuth callback route exchanges
  // the code itself, so don't probe /api/auth/me there — it would 401 (plus a
  // /api/auth/refresh retry) before the exchange completes.
  React.useEffect(() => {
    if (window.location.pathname.startsWith("/oauth/callback")) {
      setStatus("ready")
      return
    }
    let cancelled = false
    api
      .getMe()
      .then((u) => {
        if (cancelled) return
        if (u) setUser(u)
      })
      .finally(() => {
        if (!cancelled) setStatus("ready")
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Silent session keep-alive: re-check on focus / visibility + every 5 min.
  React.useEffect(() => {
    if (!user) return
    let interval: ReturnType<typeof setInterval>
    const check = () => {
      api.getMe().then((u) => setUser(u)).catch(() => {})
    }
    const onVisible = () => {
      if (document.visibilityState === "visible") check()
    }
    window.addEventListener("focus", check)
    document.addEventListener("visibilitychange", onVisible)
    interval = setInterval(check, 5 * 60 * 1000)
    return () => {
      window.removeEventListener("focus", check)
      document.removeEventListener("visibilitychange", onVisible)
      clearInterval(interval)
    }
  }, [user])

  const signIn = React.useCallback(async (keepMeLoggedIn = true) => {
    await api.startLogin(keepMeLoggedIn)
  }, [])

  const signOut = React.useCallback(async () => {
    await api.logout()
    setUser(null)
  }, [])

  const completeCallback = React.useCallback(async () => {
    const params = new URLSearchParams(window.location.search)
    const code = params.get("code")
    const state = params.get("state")
    const keep = sessionStorage.getItem("sheets_keep_me_logged_in") !== "0"
    sessionStorage.removeItem("sheets_keep_me_logged_in")
    if (!code || !state) throw new Error("Missing authorization code")
    const u = await api.handleCallback(code, state, keep)
    setUser(u)
    return u
  }, [])

  const refresh = React.useCallback(async () => {
    const u = await api.getMe()
    setUser(u)
  }, [])

  const value = React.useMemo(
    () => ({ status, user, mode, signIn, signOut, completeCallback, refresh }),
    [status, user, mode, signIn, signOut, completeCallback, refresh]
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const context = React.useContext(AuthContext)
  if (!context) throw new Error("useAuth must be used within an AuthProvider")
  return context
}