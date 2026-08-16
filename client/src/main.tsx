/**
 * Void Sheets entry point.
 *
 * Provider order matters:
 *   ThemeProvider → SettingsProvider → ToastProvider → AuthProvider
 * Router sits outermost so /oauth/callback can complete before the gate.
 */

import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { BrowserRouter } from "react-router"
import App from "@/App"
import "@/index.css"
import { ThemeProvider } from "@/components/theme-provider"
import { SettingsProvider } from "@/contexts/settings"
import { ToastProvider } from "@/contexts/toast"
import { AuthProvider } from "@/contexts/auth"
import { TooltipProvider } from "@/components/ui/tooltip"

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <ThemeProvider>
        <SettingsProvider>
          <TooltipProvider>
            <ToastProvider>
              <AuthProvider>
                <App />
              </AuthProvider>
            </ToastProvider>
          </TooltipProvider>
        </SettingsProvider>
      </ThemeProvider>
    </BrowserRouter>
  </StrictMode>
)

// Offline-first shell: register the service worker in production only.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      /* No-op — the app works without the worker. */
    })
  })
}