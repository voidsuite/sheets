/**
 * JoinPage — redeems a share link (/join/:token), then opens the sheet.
 */

import { useEffect, useRef, useState } from "react"
import { Link, useNavigate, useParams } from "react-router"
import { FileSpreadsheet, Loader2 } from "lucide-react"
import { VoidSheetsLogo } from "@/components/VoidSheetsLogo"
import { useToast } from "@/contexts/toast"
import { joinByToken } from "@/lib/api"
import { Button } from "@/components/ui/button"

export function JoinPage() {
  const { token = "" } = useParams()
  const navigate = useNavigate()
  const { toast } = useToast()
  const [error, setError] = useState<string | null>(null)
  const startedRef = useRef(false)

  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true
    joinByToken(token)
      .then((wb) => {
        toast({ title: "Added to your sheets", description: wb.name, variant: "success" })
        navigate(`/s/${wb.id}`, { replace: true })
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Invalid share link"))
  }, [token, navigate, toast])

  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-4 text-center">
      <VoidSheetsLogo size="md" tagline className="justify-center" />
      {error ? (
        <div className="mt-6 max-w-xs space-y-4">
          <div className="mx-auto flex size-12 items-center justify-center rounded-2xl bg-destructive/10">
            <FileSpreadsheet className="size-6 text-destructive" aria-hidden="true" />
          </div>
          <div className="space-y-1">
            <p className="text-sm font-medium">Couldn't open the share link</p>
            <p className="break-words text-xs text-muted-foreground">{error}</p>
          </div>
          <Button variant="outline" render={<Link to="/">Go to my sheets</Link>} />
        </div>
      ) : (
        <div className="mt-6 flex flex-col items-center gap-3 text-muted-foreground">
          <Loader2 className="size-6 animate-spin" aria-label="Joining" />
          <p className="text-xs">Opening shared sheet…</p>
        </div>
      )}
    </div>
  )
}