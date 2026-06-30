export interface ThemeColors {
  primary: string;
  primaryHover: string;
  primaryLight: string;
  accent: string;
  accentLight: string;
  sidebarBg: string;
  sidebarBgHover: string;
  sidebarText: string;
  sidebarTextMuted: string;
  sidebarActive: string;
  sidebarBorder: string;
}

export interface ThemePreset {
  key: string;
  name: string;
  industry: string;
  colors: ThemeColors;
}

export const THEMES: ThemePreset[] = [
  {
    key: "slate",
    name: "Platino Industrial",
    industry: "Default",
    colors: {
      primary: "#F58220",
      primaryHover: "#D9701A",
      primaryLight: "#FDEDDF",
      accent: "#22C55E",
      accentLight: "#E3F9EA",
      sidebarBg: "#0F4C81",
      sidebarBgHover: "#14619F",
      sidebarText: "#D7E4F0",
      sidebarTextMuted: "#7FA3C7",
      sidebarActive: "#F58220",
      sidebarBorder: "#14619F",
    },
  },
  {
    key: "industrial-blue",
    name: "Industrial Blue",
    industry: "Manufacturing",
    colors: {
      primary: "#1e40af",
      primaryHover: "#1d4ed8",
      primaryLight: "#dbeafe",
      accent: "#0ea5e9",
      accentLight: "#e0f2fe",
      sidebarBg: "#172554",
      sidebarBgHover: "#1e3a5f",
      sidebarText: "#bfdbfe",
      sidebarTextMuted: "#60a5fa",
      sidebarActive: "#1e40af",
      sidebarBorder: "#1e3a5f",
    },
  },
  {
    key: "gunmetal",
    name: "Gunmetal",
    industry: "Heavy Industry",
    colors: {
      primary: "#374151",
      primaryHover: "#4b5563",
      primaryLight: "#f3f4f6",
      accent: "#6b7280",
      accentLight: "#e5e7eb",
      sidebarBg: "#111827",
      sidebarBgHover: "#1f2937",
      sidebarText: "#d1d5db",
      sidebarTextMuted: "#9ca3af",
      sidebarActive: "#374151",
      sidebarBorder: "#1f2937",
    },
  },
  {
    key: "emerald",
    name: "Emerald",
    industry: "Clean Energy",
    colors: {
      primary: "#065f46",
      primaryHover: "#047857",
      primaryLight: "#d1fae5",
      accent: "#10b981",
      accentLight: "#a7f3d0",
      sidebarBg: "#022c22",
      sidebarBgHover: "#064e3b",
      sidebarText: "#a7f3d0",
      sidebarTextMuted: "#6ee7b7",
      sidebarActive: "#065f46",
      sidebarBorder: "#064e3b",
    },
  },
  {
    key: "terracotta",
    name: "Terracotta",
    industry: "Construction",
    colors: {
      primary: "#92400e",
      primaryHover: "#b45309",
      primaryLight: "#fef3c7",
      accent: "#f59e0b",
      accentLight: "#fde68a",
      sidebarBg: "#451a03",
      sidebarBgHover: "#78350f",
      sidebarText: "#fde68a",
      sidebarTextMuted: "#fbbf24",
      sidebarActive: "#92400e",
      sidebarBorder: "#78350f",
    },
  },
  {
    key: "royal",
    name: "Royal Indigo",
    industry: "Corporate",
    colors: {
      primary: "#4338ca",
      primaryHover: "#4f46e5",
      primaryLight: "#e0e7ff",
      accent: "#818cf8",
      accentLight: "#c7d2fe",
      sidebarBg: "#1e1b4b",
      sidebarBgHover: "#312e81",
      sidebarText: "#c7d2fe",
      sidebarTextMuted: "#a5b4fc",
      sidebarActive: "#4338ca",
      sidebarBorder: "#312e81",
    },
  },
];

export function getTheme(key: string): ThemePreset {
  return THEMES.find((t) => t.key === key) ?? THEMES[0];
}

export function applyThemeToDOM(colors: ThemeColors) {
  const root = document.documentElement;
  const map: [string, string][] = [
    ["--theme-primary", colors.primary],
    ["--theme-primary-hover", colors.primaryHover],
    ["--theme-primary-light", colors.primaryLight],
    ["--theme-accent", colors.accent],
    ["--theme-accent-light", colors.accentLight],
    ["--theme-sidebar-bg", colors.sidebarBg],
    ["--theme-sidebar-bg-hover", colors.sidebarBgHover],
    ["--theme-sidebar-text", colors.sidebarText],
    ["--theme-sidebar-text-muted", colors.sidebarTextMuted],
    ["--theme-sidebar-active", colors.sidebarActive],
    ["--theme-sidebar-border", colors.sidebarBorder],
  ];
  for (const [prop, val] of map) root.style.setProperty(prop, val);
}
