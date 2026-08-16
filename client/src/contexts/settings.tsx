import * as React from "react"
import { useTheme, type Accent } from "@/components/theme-provider"

export type Theme = "dark" | "light" | "system"

interface SettingsContextValue {
  theme: Theme
  setTheme: (theme: Theme) => void
  accent: Accent
  setAccent: (accent: Accent) => void
}

// Settings for Void Sheets are intentionally minimal: theme + accent, persisted
// by ThemeProvider in localStorage. Everything else (workspaces, boards, items)
// lives server-side and syncs automatically with your VoidAuth account.

const SettingsContext = React.createContext<SettingsContextValue | undefined>(undefined)

export function SettingsProvider({ children }: { children: React.ReactNode }) {
  const { theme, setTheme: applyTheme, accent, setAccent: applyAccent } = useTheme()

  const value = React.useMemo<SettingsContextValue>(
    () => ({
      theme,
      setTheme: applyTheme,
      accent,
      setAccent: applyAccent,
    }),
    [theme, applyTheme, accent, applyAccent]
  )

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>
}

export function useSettings(): SettingsContextValue {
  const context = React.useContext(SettingsContext)
  if (!context) throw new Error("useSettings must be used within a SettingsProvider")
  return context
}