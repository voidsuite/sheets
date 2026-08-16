import * as React from "react"

export type Accent = "stone" | "violet" | "emerald" | "amber" | "sky" | "rose"

export const ACCENTS: { id: Accent; label: string }[] = [
  { id: "stone", label: "Stone" },
  { id: "violet", label: "Violet" },
  { id: "emerald", label: "Emerald" },
  { id: "amber", label: "Amber" },
  { id: "sky", label: "Sky" },
  { id: "rose", label: "Rose" },
]

type Theme = "dark" | "light" | "system"
type ResolvedTheme = "dark" | "light"

type ThemeProviderProps = {
  children: React.ReactNode
  defaultTheme?: Theme
  storageKey?: string
  disableTransitionOnChange?: boolean
}

type ThemeProviderState = {
  theme: Theme
  setTheme: (theme: Theme) => void
  accent: Accent
  setAccent: (accent: Accent) => void
}

const COLOR_SCHEME_QUERY = "(prefers-color-scheme: dark)"
const THEME_VALUES: Theme[] = ["dark", "light", "system"]
const ACCENT_VALUES: Accent[] = ["stone", "violet", "emerald", "amber", "sky", "rose"]

const ThemeProviderContext = React.createContext<ThemeProviderState | undefined>(undefined)

function isTheme(value: string | null): value is Theme {
  return value !== null && THEME_VALUES.includes(value as Theme)
}

function isAccent(value: string | null): value is Accent {
  return value !== null && ACCENT_VALUES.includes(value as Accent)
}

function getSystemTheme(): ResolvedTheme {
  if (window.matchMedia(COLOR_SCHEME_QUERY).matches) return "dark"
  return "light"
}

function disableTransitionsTemporarily() {
  const style = document.createElement("style")
  style.appendChild(
    document.createTextNode(
      "*,*::before,*::after{-webkit-transition:none!important;transition:none!important}"
    )
  )
  document.head.appendChild(style)
  return () => {
    window.getComputedStyle(document.body)
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        style.remove()
      })
    })
  }
}

export function ThemeProvider({
  children,
  defaultTheme = "dark",
  storageKey = "sheets_theme",
  disableTransitionOnChange = true,
  ...props
}: ThemeProviderProps) {
  const [theme, setThemeState] = React.useState<Theme>(() => {
    const stored = localStorage.getItem(storageKey)
    if (isTheme(stored)) return stored
    return defaultTheme
  })
  const [accent, setAccentState] = React.useState<Accent>(() => {
    const stored = localStorage.getItem("sheets_accent")
    if (isAccent(stored)) return stored
    return "stone"
  })

  const setTheme = React.useCallback(
    (nextTheme: Theme) => {
      localStorage.setItem(storageKey, nextTheme)
      setThemeState(nextTheme)
    },
    [storageKey]
  )

  const setAccent = React.useCallback((nextAccent: Accent) => {
    localStorage.setItem("sheets_accent", nextAccent)
    setAccentState(nextAccent)
  }, [])

  const applyTheme = React.useCallback(
    (nextTheme: Theme) => {
      const root = document.documentElement
      const resolvedTheme = nextTheme === "system" ? getSystemTheme() : nextTheme
      const restoreTransitions = disableTransitionOnChange ? disableTransitionsTemporarily() : null
      root.classList.remove("light", "dark")
      root.classList.add(resolvedTheme)
      if (restoreTransitions) restoreTransitions()
    },
    [disableTransitionOnChange]
  )

  // Apply accent attribute immediately when it changes
  React.useEffect(() => {
    document.documentElement.dataset.accent = accent
  }, [accent])

  React.useEffect(() => {
    applyTheme(theme)
    if (theme !== "system") return undefined
    const mediaQuery = window.matchMedia(COLOR_SCHEME_QUERY)
    const handleChange = () => applyTheme("system")
    mediaQuery.addEventListener("change", handleChange)
    return () => mediaQuery.removeEventListener("change", handleChange)
  }, [theme, applyTheme])

  const value = React.useMemo(() => ({ theme, setTheme, accent, setAccent }), [theme, setTheme, accent, setAccent])

  return (
    <ThemeProviderContext.Provider {...props} value={value}>
      {children}
    </ThemeProviderContext.Provider>
  )
}

export function useTheme() {
  const context = React.useContext(ThemeProviderContext)
  if (context === undefined) throw new Error("useTheme must be used within a ThemeProvider")
  return context
}