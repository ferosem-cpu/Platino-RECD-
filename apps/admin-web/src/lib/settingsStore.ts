import type { ThemeColors } from "./themes";

const KEYS = {
  THEME: "recd_theme_key",
  CUSTOM_COLORS: "recd_custom_colors",
  LOGO: "recd_company_logo",
} as const;

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

export function getSavedThemeKey(): string {
  if (typeof window === "undefined") return "slate";
  return window.localStorage.getItem(KEYS.THEME) ?? "slate";
}

export function saveThemeKey(key: string) {
  window.localStorage.setItem(KEYS.THEME, key);
}

// ---------------------------------------------------------------------------
// Custom colours (when the user extracts a palette from an image)
// ---------------------------------------------------------------------------

export function getSavedCustomColors(): ThemeColors | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(KEYS.CUSTOM_COLORS);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ThemeColors;
  } catch {
    return null;
  }
}

export function saveCustomColors(colors: ThemeColors) {
  window.localStorage.setItem(KEYS.CUSTOM_COLORS, JSON.stringify(colors));
}

export function clearCustomColors() {
  window.localStorage.removeItem(KEYS.CUSTOM_COLORS);
}

// ---------------------------------------------------------------------------
// Company logo (stored as base64 data-URL)
// ---------------------------------------------------------------------------

export function getSavedLogo(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(KEYS.LOGO);
}

export function saveLogo(dataUrl: string) {
  window.localStorage.setItem(KEYS.LOGO, dataUrl);
}

export function clearLogo() {
  window.localStorage.removeItem(KEYS.LOGO);
}

// ---------------------------------------------------------------------------
// File → data-URL helper
// ---------------------------------------------------------------------------

export function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
