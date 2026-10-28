/**
 * Dark theme for the Univer grid.
 *
 * Univer ships only light palettes (defaultTheme / greenTheme), and the grid
 * canvas paints itself from the JS theme object — so to make the sheet editor
 * dark we swap in a dark token set on ThemeService and flip Univer's DOM-dark
 * hooks on. The DOM chrome (toolbar, footer, dialogs) is driven by CSS via the
 * `univer-dark` class + `--univer-*` variables (see index.css).
 */

import { defaultTheme } from "@univerjs/presets"
import { ThemeService } from "@univerjs/core"
import type { Theme } from "@univerjs/themes"

type Shade = "50" | "100" | "200" | "300" | "400" | "500" | "600" | "700" | "800" | "900"

// Inverted gray ladder (zinc-flavored): in light mode gray-50 was the lightest
// surface; in dark mode the ladder means "light-ish surface" → "dark surface".
const DARK_GRAY: Record<Shade, string> = {
  "50": "#141518",
  "100": "#1B1D21",
  "200": "#23262B",
  "300": "#2C3036",
  "400": "#3A3F47",
  "500": "#565C66",
  "600": "#71787F",
  "700": "#9AA0A6",
  "800": "#C7CBCF",
  "900": "#E6E8EB",
}

// Default theme's color groups (gray excluded — handled above).
const GROUPS = ["primary", "blue", "red", "orange", "yellow", "green", "indigo", "purple", "pink", "jiqing"] as const

/**
 * Take the recorded color shades from the light theme and pick compatible
 * shades for a dark backdrop by shifting each token's shade group up the
 * ladder (60x → 30x/40x). We copy the *values* from the light theme, so the
 * mapping below just chooses which recorded shade each dark token reuses.
 */
function recolorGroup(g: Record<Shade, string>): Record<Shade, string> {
  return {
    "50": g["700"],
    "100": g["600"],
    "200": g["500"],
    "300": g["400"],
    "400": g["300"],
    "500": g["200"],
    "600": g["100"],
    "700": g["50"],
    "800": g["50"],
    "900": g["50"],
  }
}

export function buildDarkTheme(): Theme {
  const base = defaultTheme as any
  const dark: Record<string, unknown> = {
    white: "#1B1D21", // sheet surface ("white" in a dark sheet = near-black)
    black: "#E6E8EB", // primary text color
    gray: DARK_GRAY,
  }
  for (const g of GROUPS) {
    if (base[g] && typeof base[g] === "object") {
      dark[g] = recolorGroup(base[g] as Record<Shade, string>)
    }
  }
  return dark as Theme
}

/**
 * Apply the Void dark theme to a running Univer instance:
 *  1. swap the JS theme object (repaints the grid canvas),
 *  2. flip Univer's DOM-dark hooks (`univer-dark` class on <html>).
 * Safe to call before the first sheet render; re-calling is a no-op flip.
 */
export function applyDarkTheme(univer: { __getInjector(): unknown }, univerAPI: { toggleDarkMode(on: boolean): void }): void {
  try {
    const injector = univer.__getInjector() as { get<T>(id: unknown): T }
    const themeService = injector.get<{ setTheme(theme: Theme): void }>(ThemeService)
    themeService.setTheme(buildDarkTheme())
  } catch {
    // ThemeService unavailable — still flip the DOM hooks below.
  }
  univerAPI.toggleDarkMode(true)
}