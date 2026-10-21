// The signature PNG checks and the signed-PDF generator (pure functions, no database, no network).
// All names, serials and text below are synthetic.
import test from "node:test";
import assert from "node:assert/strict";
import { SERVICE_REPORT_LIMITS } from "@recd/shared";
import { checkSignatureDataUrl } from "../src/lib/signatureImage";
import { buildServiceReportPdf, type ServiceReportPdfInput } from "../src/lib/serviceReportPdf";
import { makePng, pngDataUrl } from "./helpers/png";

const ok = (png: Buffer) => checkSignatureDataUrl(pngDataUrl(png));

test("signature check: a drawn PNG of a sensible size is accepted", () => {
  const r = ok(makePng());
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.width, 300);
    assert.equal(r.height, 120);
    assert.ok(r.bytes.length > 40);
  }
});

test("signature check: missing, wrong-type, malformed and oversized payloads are rejected", () => {
  const good = makePng();
  const cases: Array<[string, unknown]> = [
    ["undefined", undefined],
    ["null", null],
    ["a number", 42],
    ["empty string", ""],
    ["a typed name instead of an image", "Asha Rao"],
    ["jpeg prefix", `data:image/jpeg;base64,${good.toString("base64")}`],
    ["svg", "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4="],
    ["prefix only", "data:image/png;base64,"],
    ["not base64", "data:image/png;base64,@@@@not-base64@@@@"],
    ["bad padding", `data:image/png;base64,${good.toString("base64")}=`],
    ["base64 of text", `data:image/png;base64,${Buffer.from("hello world, this is not a png file at all!!").toString("base64")}`],
    ["truncated png", pngDataUrl(good.subarray(0, 60))],
    ["png without IEND", pngDataUrl(good.subarray(0, good.length - 12))],
  ];
  for (const [label, value] of cases) assert.equal(checkSignatureDataUrl(value).ok, false, label);

  const big = Buffer.concat([good, Buffer.alloc(SERVICE_REPORT_LIMITS.SIGNATURE_MAX_BYTES + 10)]);
  const tooBig = checkSignatureDataUrl(pngDataUrl(big));
  assert.equal(tooBig.ok, false);
  if (!tooBig.ok) assert.match(tooBig.reason, /too large/);
});

test("signature check: an empty (fully transparent) canvas is refused with a clear message", () => {
  const r = ok(makePng({ ink: false }));
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /draw your signature/i);
});

test("signature check: unsupported formats and absurd dimensions are refused", () => {
  assert.equal(ok(makePng({ colourType: 2 })).ok, false, "RGB (no alpha) is not what the pad produces");
  assert.equal(ok(makePng({ width: 20, height: 20 })).ok, false, "tiny");
  assert.equal(ok(makePng({ width: SERVICE_REPORT_LIMITS.SIGNATURE_MAX_DIMENSION + 1, height: 100 })).ok, false, "huge width");
  assert.equal(ok(makePng({ width: 100, height: SERVICE_REPORT_LIMITS.SIGNATURE_MAX_DIMENSION + 1 })).ok, false, "huge height");
});

test("signature check: a small file that inflates far beyond its declared size is refused (no decompression bomb)", () => {
  const bomb = makePng({ width: 100, height: 100, rawOverride: Buffer.alloc(50_000_000) });
  assert.ok(bomb.length < SERVICE_REPORT_LIMITS.SIGNATURE_MAX_BYTES, "compresses to a small upload");
  assert.equal(ok(bomb).ok, false);
});

// ---------------------------------------------------------------------------------------------------------

const base = (over: Partial<ServiceReportPdfInput> = {}): ServiceReportPdfInput => ({
  reportNumber: "TCK-2026-12345-R1",
  ticketNumber: "TCK-2026-12345",
  customerName: "Acme Power Pvt Ltd",
  siteName: "Acme Plant 2",
  siteAddress: "12 Industrial Estate, Coimbatore",
  recdSerial: "SN-A1-0042",
  recdModel: "RECD (RECD-250)",
  dgModel: "Kirloskar KG1-250",
  dgCapacityKva: 250,
  visitDate: new Date("2026-10-14T00:00:00Z"),
  engineerName: "Ravi Engineer",
  workPerformed: "Replaced the catalyst housing gasket and re-torqued the flange bolts.",
  findings: "Exhaust leak at the inlet flange; back-pressure above limit.",
  resolution: "Leak sealed; back-pressure back within limits after a 30 minute load test.",
  partsUsed: "Gasket G-250 x1",
  remarks: "Customer asked for a follow-up check in 30 days.",
  signerName: "Asha Rao",
  signedAt: new Date("2026-10-15T08:30:00Z"),
  version: 2,
  contentHash: "a".repeat(64),
  signaturePng: makePng(),
  ...over,
});

async function textOf(pdf: Buffer): Promise<string> {
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: new Uint8Array(pdf) });
  try {
    return (await parser.getText()).text;
  } finally {
    await parser.destroy();
  }
}

test("signed PDF: a real PDF with every required section, the signer, the date and the final marker", async () => {
  const pdf = await buildServiceReportPdf(base());
  assert.equal(pdf.subarray(0, 5).toString("latin1"), "%PDF-");
  assert.match(pdf.subarray(pdf.length - 8).toString("latin1"), /%%EOF/);
  const text = await textOf(pdf);
  for (const expected of [
    "Service Report",
    "SIGNED - FINAL",
    "TCK-2026-12345-R1",
    "TCK-2026-12345",
    "Acme Power Pvt Ltd",
    "Acme Plant 2",
    "12 Industrial Estate",
    "SN-A1-0042",
    "Kirloskar KG1-250",
    "250 kVA",
    "2026-10-14",
    "Ravi Engineer",
    "Replaced the catalyst housing gasket",
    "Exhaust leak at the inlet flange",
    "Leak sealed",
    "Gasket G-250",
    "follow-up check in 30 days",
    "Customer signature",
    "Signed by: Asha Rao",
    "Signed on:",
    "2026-10-15T08:30:00.000Z",
  ]) {
    assert.ok(text.includes(expected), `PDF text should contain: ${expected}`);
  }
});

test("signed PDF: the signature image is embedded in the document, and a different signature gives a different file", async () => {
  const a = await buildServiceReportPdf(base());
  const b = await buildServiceReportPdf(base({ signaturePng: makePng({ width: 360, height: 140 }) }));
  const imageCount = (pdf: Buffer) => (pdf.toString("latin1").match(/\/Subtype\s*\/Image/g) ?? []).length;
  assert.ok(imageCount(a) >= 1, "an image object is present");
  assert.ok(imageCount(b) >= 1);
  assert.ok(!a.equals(b));
  const withoutImage = await buildServiceReportPdf(base());
  assert.ok(withoutImage.length > 1500);
});

test("signed PDF: missing optional data prints a dash instead of breaking, and long text flows over several pages", async () => {
  const sparse = await buildServiceReportPdf(base({ siteName: null, siteAddress: null, recdSerial: null, recdModel: null, dgModel: null, dgCapacityKva: null, partsUsed: null, remarks: null }));
  const sparseText = await textOf(sparse);
  assert.ok(sparseText.includes("RECD serial number: -"));
  assert.ok(!sparseText.includes("Parts used"));

  const long = "Checked the exhaust line and logged the readings. ".repeat(120);
  const big = await buildServiceReportPdf(base({ workPerformed: long, findings: long, resolution: long }));
  const pages = (big.toString("latin1").match(/\/Type\s*\/Page[^s]/g) ?? []).length;
  assert.ok(pages >= 3, `expected a multi-page document, got ${pages}`);
  const text = await textOf(big);
  assert.ok(text.includes("Signed by: Asha Rao"), "the signature block survives the page breaks");
});

test("signed PDF: an unusable signature image makes generation fail instead of producing an unsigned document", async () => {
  await assert.rejects(buildServiceReportPdf(base({ signaturePng: Buffer.from("not a png") })));
});

// ---------------------------------------------------------------------------------------------------------
// AMC reports (Requirement 5)

const amcBase = (over: Partial<ServiceReportPdfInput> = {}): ServiceReportPdfInput =>
  base({
    kind: "amc",
    reportNumber: "AMC-ABC123-R2",
    ticketNumber: null,
    amc: { orderRef: "AMC-ABC123", poNo: "PO-7788", poDate: new Date("2026-04-01T00:00:00Z"), typeLabel: "CAMC (Comprehensive)", frequencyPerYear: 4, location: "Coimbatore plant" },
    recdSerial: "SN-AMC-0007",
    ...over,
  });

test("AMC signed PDF: AMC order, type, contract details, serial, customer, site, DG, signer and signature are all in the file", async () => {
  const pdf = await buildServiceReportPdf(amcBase());
  const text = await textOf(pdf);
  for (const expected of [
    "AMC Service Report", "SIGNED - FINAL", "AMC-ABC123-R2", "AMC order: AMC-ABC123 (PO PO-7788, 2026-04-01)", "CAMC (Comprehensive)",
    "Contracted visits per year: 4", "Coimbatore plant", "Acme Power Pvt Ltd", "Acme Plant 2", "SN-AMC-0007", "Kirloskar KG1-250", "250 kVA",
    "2026-10-14", "Ravi Engineer", "Replaced the catalyst housing gasket", "Signed by: Asha Rao", "Gasket G-250",
  ]) assert.ok(text.includes(expected), `AMC PDF should contain: ${expected}`);
  assert.ok(!text.includes("Service ticket"), "an AMC report is not labelled as a ticket report");
  assert.ok((pdf.toString("latin1").match(/\/Subtype\s*\/Image/g) ?? []).length >= 1, "the signature image is embedded");
});

test("AMC submitted PDF (acknowledgement not required): clearly final but NOT signed, no signature image, no 'Signed by'", async () => {
  const pdf = await buildServiceReportPdf(amcBase({ finalState: "submitted", submittedAt: new Date("2026-10-15T09:00:00Z"), signerName: null, signedAt: null, signaturePng: null }));
  const text = await textOf(pdf);
  assert.ok(text.includes("SUBMITTED - FINAL, NOT SIGNED"));
  assert.ok(text.includes("Customer acknowledgement"));
  assert.ok(text.includes("Not required for this report"));
  assert.ok(text.includes("2026-10-15T09:00:00.000Z"));
  assert.ok(!text.includes("SIGNED - FINAL"), "never described as signed");
  assert.ok(!text.includes("Signed by"));
  assert.ok(!text.includes("Customer signature"));
  assert.equal((pdf.toString("latin1").match(/\/Subtype\s*\/Image/g) ?? []).length, 0, "no signature image");
});

test("a 'signed' PDF cannot be produced without the signature, signer and time", async () => {
  await assert.rejects(buildServiceReportPdf(amcBase({ signaturePng: null })));
  await assert.rejects(buildServiceReportPdf(amcBase({ signerName: null })));
  await assert.rejects(buildServiceReportPdf(amcBase({ signedAt: null })));
});
