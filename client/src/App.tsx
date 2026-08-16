/**
 * App — route shell for Void Sheets.
 *
 * Gate: while auth is loading show a splash; until the user is signed in show
 * the VoidAuth login page. The OAuth callback route always renders so it can
 * complete the code exchange regardless of gate state.
 */

import { Navigate, Route, Routes } from "react-router"
import { Loader2 } from "lucide-react"
import { useAuth } from "@/contexts/auth"
import { LoginPage } from "@/components/login-page"
import { OAuthCallback } from "@/components/oauth-callback"
import { VoidSheetsLogo } from "@/components/VoidSheetsLogo"
import { HomePage } from "@/pages/HomePage"
import { SheetPage } from "@/pages/SheetPage"
import { JoinPage } from "@/pages/JoinPage"

function Splash() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-5 bg-background">
      <VoidSheetsLogo size="lg" tagline />
      <Loader2 className="size-5 animate-spin text-muted-foreground" aria-label="Loading" />
    </div>
  )
}

function Gates() {
  const { status, user } = useAuth()
  if (status === "loading") return <Splash />
  if (!user) return <LoginPage />
  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route path="/s/:id" element={<SheetPage />} />
      <Route path="/join/:token" element={<JoinPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

export default function App() {
  return (
    <Routes>
      <Route path="/oauth/callback" element={<OAuthCallback />} />
      <Route path="*" element={<Gates />} />
    </Routes>
  )
}