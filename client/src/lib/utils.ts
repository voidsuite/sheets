import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Haptic / force feedback. Falls back to a CSS "pulse" via the returned
 * event when the device has no vibrate API. Safe to call anywhere.
 */
export function haptic(pattern: number | number[] = 10) {
  if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
    try {
      navigator.vibrate(pattern)
    } catch {
      /* noop */
    }
  }
}

/** Spring-like scale for pressable elements (used with active:). */
export const pressable = "transition-transform active:scale-[0.97]"

/** Shared subtle entry animation for newly rendered panels/items. */
export const enterAnim = "animate-in fade-in duration-200"
