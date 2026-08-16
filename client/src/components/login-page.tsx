import { useState } from "react"
import { ChevronLeft, Files, Lock, RefreshCcw, Sigma } from "lucide-react"
import { Button } from "@/components/ui/button"
import { VoidSheetsLogo } from "@/components/VoidSheetsLogo"
import { useAuth } from "@/contexts/auth"

/**
 * Login — the only way in is "Sign in with VoidAuth". Void Sheets is
 * server-authoritative: your spreadsheets live on the account and sync to any
 * device automatically — no passphrase, nothing to enter.
 */
export function LoginPage() {
  const { signIn } = useAuth()
  const [step, setStep] = useState<"landing" | "confirm_remember">("landing")

  if (step === "confirm_remember") {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center px-4">
        <div className="w-full max-w-xs space-y-6 text-center">
          <div className="flex justify-center">
            <VoidSheetsLogo size="lg" tagline />
          </div>
          <div className="space-y-2">
            <p className="text-sm font-medium">Keep you signed in?</p>
            <p className="text-xs text-muted-foreground">Stay signed in for up to 30 days</p>
          </div>
          <div className="flex gap-3">
            <Button type="button" variant="outline" className="flex-1" size="lg" onClick={() => signIn(false)}>
              No
            </Button>
            <Button type="button" className="flex-1" size="lg" onClick={() => signIn(true)}>
              Yes
            </Button>
          </div>
          <button
            className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
            onClick={() => setStep("landing")}
          >
            <ChevronLeft className="size-3" />
            Back
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-4">
      <div className="w-full max-w-sm space-y-8 text-center">
        <div className="space-y-2">
          <div className="mx-auto flex size-14 items-center justify-center rounded-2xl bg-primary/10">
            <Files className="size-7 text-primary" aria-hidden="true" />
          </div>
          <VoidSheetsLogo size="lg" tagline className="justify-center" />
          <p className="text-sm text-muted-foreground">Collaborative spreadsheets for the VoidSuite family</p>
        </div>

        <div className="space-y-3 rounded-xl border border-border bg-card/50 p-5 text-left">
          <div className="flex items-center gap-2.5">
            <Sigma className="size-4 flex-shrink-0 text-muted-foreground" aria-hidden="true" />
            <p className="text-xs text-muted-foreground">Every Excel function, formatting and keyboard shortcut</p>
          </div>
          <div className="flex items-center gap-2.5">
            <RefreshCcw className="size-4 flex-shrink-0 text-muted-foreground" aria-hidden="true" />
            <p className="text-xs text-muted-foreground">Live multi-user editing, presence and cursors</p>
          </div>
          <div className="flex items-center gap-2.5">
            <Lock className="size-4 flex-shrink-0 text-muted-foreground" aria-hidden="true" />
            <p className="text-xs text-muted-foreground">Optional end-to-end encryption per sheet</p>
          </div>
        </div>

        <Button size="lg" className="w-full gap-2" onClick={() => setStep("confirm_remember")}>
          Sign in with VoidAuth
        </Button>

        <p className="text-xs text-muted-foreground">
          Part of the <span className="font-medium text-foreground">VoidSuite</span> — voidboard, docs, draw, m3il, authiov
        </p>
      </div>
    </div>
  )
}