import type { ThemeColors } from "./themes";

/**
 * Loads an image data-URL into an off-screen canvas, samples pixels, and
 * returns the top N dominant colours as hex strings.
 */
export async function extractDominantColors(
  dataUrl: string,
  sampleCount = 5
): Promise<string[]> {
  const img = await loadImage(dataUrl);
  const canvas = document.createElement("canvas");
  // Downsample for performance - 100px wide is plenty for colour extraction
  const scale = Math.min(1, 100 / img.width);
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const buckets = new Map<string, number>();

  // Quantise each pixel to the nearest 32-step to group similar colours
  for (let i = 0; i < data.length; i += 4) {
    const r = Math.round(data[i] / 32) * 32;
    const g = Math.round(data[i + 1] / 32) * 32;
    const b = Math.round(data[i + 2] / 32) * 32;
    const a = data[i + 3];
    if (a < 128) continue; // skip transparent
    const key = `${r},${g},${b}`;
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }

  // Sort by frequency, filter out near-white and near-black
  const sorted = [...buckets.entries()]
    .filter(([key]) => {
      const [r, g, b] = key.split(",").map(Number);
      const brightness = (r + g + b) / 3;
      return brightness > 30 && brightness < 230;
    })
    .sort((a, b) => b[1] - a[1]);

  // Pick diverse colours (skip colours too close to already-picked ones)
  const picked: string[] = [];
  for (const [key] of sorted) {
    if (picked.length >= sampleCount) break;
    const [r, g, b] = key.split(",").map(Number);
    const hex = rgbToHex(r, g, b);
    const tooClose = picked.some((p) => colorDistance(p, hex) < 80);
    if (!tooClose) picked.push(hex);
  }

  // Pad with fallbacks if image had few distinct colours
  while (picked.length < sampleCount) {
    picked.push(picked.length % 2 === 0 ? "#334155" : "#3b82f6");
  }

  return picked;
}

/**
 * Takes an array of dominant colours and maps them into a full `ThemeColors`
 * palette suitable for the app's CSS variables.
 */
export function colorsToTheme(dominantColors: string[]): ThemeColors {
  const [c1, c2, c3] = dominantColors;
  return {
    primary: c1,
    primaryHover: lighten(c1, 15),
    primaryLight: lighten(c1, 85),
    accent: c2,
    accentLight: lighten(c2, 80),
    sidebarBg: darken(c1, 40),
    sidebarBgHover: darken(c1, 25),
    sidebarText: lighten(c1, 80),
    sidebarTextMuted: lighten(c1, 55),
    sidebarActive: c1,
    sidebarBorder: darken(c1, 30),
  };
}

// ── helpers ──────────────────────────────────────────────────────────────────

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function rgbToHex(r: number, g: number, b: number): string {
  return (
    "#" +
    [r, g, b]
      .map((v) =>
        Math.max(0, Math.min(255, v))
          .toString(16)
          .padStart(2, "0")
      )
      .join("")
  );
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [
    parseInt(h.substring(0, 2), 16),
    parseInt(h.substring(2, 4), 16),
    parseInt(h.substring(4, 6), 16),
  ];
}

function lighten(hex: string, amount: number): string {
  const [r, g, b] = hexToRgb(hex);
  const f = amount / 100;
  return rgbToHex(
    Math.round(r + (255 - r) * f),
    Math.round(g + (255 - g) * f),
    Math.round(b + (255 - b) * f)
  );
}

function darken(hex: string, amount: number): string {
  const [r, g, b] = hexToRgb(hex);
  const f = 1 - amount / 100;
  return rgbToHex(Math.round(r * f), Math.round(g * f), Math.round(b * f));
}

function colorDistance(hex1: string, hex2: string): number {
  const [r1, g1, b1] = hexToRgb(hex1);
  const [r2, g2, b2] = hexToRgb(hex2);
  return Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2);
}
