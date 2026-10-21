// Dependency-free CSV export used by the Reports section — builds a CSV string
// client-side and triggers a browser download via a Blob (no server round-trip,
// no charting/export library needed).

// A cell that starts with one of these is run as a formula by Excel / Sheets when the file is
// opened ("CSV injection"). Customer-supplied text (complaint descriptions, names) can reach
// these exports, so such text is neutralised with a leading apostrophe.
const FORMULA_START = /^[=+\-@\t\r]/;
// Plain numbers such as "-5" or "-1250.50" are data, not formulas, and must stay numeric.
const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;

export function escapeCsvCell(value: string | number | null | undefined): string {
  let s = value === null || value === undefined ? "" : String(value);
  if (typeof value !== "number" && FORMULA_START.test(s) && !PLAIN_NUMBER.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** The CSV text (without the BOM), rows joined with CRLF. */
export function buildCsv(headers: string[], rows: (string | number | null | undefined)[][]): string {
  return [headers, ...rows].map((row) => row.map(escapeCsvCell).join(",")).join("\r\n");
}

export function downloadCsv(filename: string, headers: string[], rows: (string | number | null | undefined)[][]) {
  // Leading BOM so Excel opens UTF-8 (₹ etc.) correctly instead of mangling it.
  const blob = new Blob(["﻿" + buildCsv(headers, rows)], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename.endsWith(".csv") ? filename : `${filename}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
