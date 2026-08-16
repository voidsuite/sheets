import { useEffect, useRef, useState } from "react"
import { useNavigate } from "react-router"
import { AlertCircle, CheckCircle2, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { VoidSheetsLogo } from "@/components/VoidSheetsLogo"
import { useAuth } from "@/contexts/auth"
import { useToast } from "@/contexts/toast"

/**
 * Rendered at /oauth/callback — swaps the code for a session, then cleans
 * the URL and lets the app take over.
 *
 * The exchange consumes the server-side PKCE verifier and the OAuth code, so
 * it must run exactly once per page load. In dev, React StrictMode double-
 * invokes effects — guard with a ref so the second invocation is a no-op.
 */
export function OAuthCallback() {
  const { completeCallback } = useAuth()
  const { toast } = useToast()
  const navigate = useNavigate()
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const startedRef = useRef(false)

  useEffect(() => {
    if (startedRef.current || done) return
    startedRef.current = true
    completeCallback()
      .then(() => {
        setDone(true)
        // Navigate for real — replaceState only rewrites the URL bar, which
        // left the router stuck on this page showing the spinner forever.
        navigate("/", { replace: true })
        toast({ title: "Signed in", description: "Your sheets are ready.", variant: "success" })
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Sign-in failed")
      })
  }, [completeCallback, done, navigate, toast])

  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-4">
      <div className="w-full max-w-xs space-y-6 text-center">
        <VoidSheetsLogo size="lg" tagline className="justify-center" />
        {error ? (
          <div className="space-y-4">
            <div className="mx-auto flex size-12 items-center justify-center rounded-2xl bg-destructive/10">
              <AlertCircle className="size-6 text-destructive" aria-hidden="true" />
            </div>
            <div className="space-y-1">
              <p className="text-sm font-medium">Couldn't sign in</p>
              <p className="break-words text-xs text-muted-foreground">{error}</p>
            </div>
            <Button className="w-full" variant="outline" onClick={() => (window.location.href = "/")}>
              Try again
            </Button>
          </div>
        ) : done ? (
          <div className="space-y-3">
            <CheckCircle2 className="mx-auto size-6 text-emerald-500" aria-hidden="true" />
            <p className="text-sm text-muted-foreground">Signed in — taking you to your sheets…</p>
          </div>
        ) : (
          <div className="space-y-3">
            <Loader2 className="mx-auto size-6 animate-spin text-muted-foreground" aria-hidden="true" />
            <p className="text-sm text-muted-foreground">Completing sign-in…</p>
          </div>
        )}
      </div>
    </div>
  )
}