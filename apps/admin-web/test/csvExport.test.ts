import test from "node:test";
import assert from "node:assert/strict";
import { escapeCsvCell, buildCsv } from "../src/lib/csvExport";

test("plain values pass through; commas, quotes and line breaks are quoted", () => {
  assert.equal(escapeCsvCell("SN-001"), "SN-001");
  assert.equal(escapeCsvCell("a,b"), '"a,b"');
  assert.equal(escapeCsvCell('say "hi"'), '"say ""hi"""');
  assert.equal(escapeCsvCell("line1\nline2"), '"line1\nline2"');
  assert.equal(escapeCsvCell("line1\rline2"), '"line1\rline2"');
  assert.equal(escapeCsvCell(null), "");
  assert.equal(escapeCsvCell(undefined), "");
  assert.equal(escapeCsvCell(42), "42");
});

test("spreadsheet formulas in text are neutralised", () => {
  for (const evil of ["=1+1", "+SUM(A1)", "-2+3", "@cmd", "\t=1", "\r=1", '=HYPERLINK("http://x","y")']) {
    assert.ok(escapeCsvCell(evil).replace(/^"/, "").startsWith("'"), `not neutralised: ${JSON.stringify(evil)}`);
  }
  assert.equal(escapeCsvCell("=1+1"), "'=1+1");
  assert.equal(escapeCsvCell('=HYPERLINK("http://x","y")'), `"'=HYPERLINK(""http://x"",""y"")"`);
});

test("real numbers and numeric strings are left alone", () => {
  assert.equal(escapeCsvCell(-5), "-5");
  assert.equal(escapeCsvCell("-5"), "-5");
  assert.equal(escapeCsvCell("-1250.50"), "-1250.50");
  assert.equal(escapeCsvCell("850000"), "850000");
});

test("serial numbers (letters or digits first, then letters, digits and - _ / .) are never altered", () => {
  for (const s of ["SN-A1", "RC-2026/0001", "A.B_C-9", "9XYZ"]) assert.equal(escapeCsvCell(s), s);
});

test("buildCsv joins rows with CRLF and escapes every cell", () => {
  assert.equal(buildCsv(["a", "b"], [["x", "=y"], [null, 'q"']]), `a,b\r\nx,'=y\r\n,"q"""`);
});
