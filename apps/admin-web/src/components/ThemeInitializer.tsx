"use client";

import { useEffect } from "react";
import { getSavedThemeKey, getSavedCustomColors } from "@/lib/settingsStore";
import { getTheme, applyThemeToDOM } from "@/lib/themes";

/**
 * Client component that runs once on mount to apply the saved theme's CSS
 * variables to :root so that every page renders with the correct colours
 * from the very first paint.
 */
export default function ThemeInitializer() {
  const apply = () => {
    const key = getSavedThemeKey();
    if (key === "custom") {
      const custom = getSavedCustomColors();
      if (custom) {
        applyThemeToDOM(custom);
        return;
      }
    }
    const theme = getTheme(key);
    applyThemeToDOM(theme.colors);
  };

  useEffect(() => {
    apply();
    window.addEventListener("settings-changed", apply);
    return () => window.removeEventListener("settings-changed", apply);
  }, []);

  return null;
}
