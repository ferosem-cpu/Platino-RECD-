/**
 * Builds the final signed service-report PDF on the server from stored report data and the validated signature PNG.
 * Nothing in the document comes from client-supplied PDF bytes. Fonts are PDFKit's built-in Helvetica (Latin
 * characters only - text in other scripts would not render; a font file would be needed for that).
 */
import PDFDocument from "pdfkit";

/** AMC details printed on an AMC service report. */
export interface AmcPdfInfo {
  /** Short identifier of the AMC order (the contract has no number of its own besides the PO). */
  orderRef: string;
  poNo: string;
  poDate: Date;
  typeLabel: string;
  /** Contracted visits per year - the SCHEDULE; each report below records one ACTUAL visit. */
  frequencyPerYear: number;
  location: string;
}

export interface ServiceReportPdfInput {
  reportNumber: string;
  /** "ticket" (default) or "amc". */
  kind?: "ticket" | "amc";
  /** Ticket reports only. */
  ticketNumber: string | null;
  /** AMC reports only. */
  amc?: AmcPdfInfo | null;
  /** "signed" (customer signature below) or "submitted" (final, acknowledgement not required - NOT signed). Default signed. */
  finalState?: "signed" | "submitted";
  submittedAt?: Date | null;
  customerName: string;
  siteName: string | null;
  siteAddress: string | null;
  recdSerial: string | null;
  recdModel: string | null;
  dgModel: string | null;
  dgCapacityKva: number | null;
  visitDate: Date;
  engineerName: string;
  workPerformed: string;
  findings: string;
  resolution: string;
  partsUsed: string | null;
  remarks: string | null;
  signerName?: string | null;
  signedAt?: Date | null;
  version: number;
  contentHash: string;
  signaturePng?: Buffer | null;
}

const dateOnly = (d: Date) => d.toISOString().slice(0, 10);
const dateTime = (d: Date) => `${d.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "medium" })} IST (${d.toISOString()})`;

export function buildServiceReportPdf(r: ServiceReportPdfInput): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: "A4",
        margin: 50,
        info: { Title: `${r.kind === "amc" ? "AMC service report" : "Service report"} ${r.reportNumber}`, Author: "Platino", Subject: r.kind === "amc" ? `AMC ${r.amc?.poNo ?? ""}` : `Ticket ${r.ticketNumber}` },
      });
      const chunks: Buffer[] = [];
      doc.on("data", (c: Buffer) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      const width = doc.page.width - 100;
      const signed = (r.finalState ?? "signed") === "signed";
      doc.font("Helvetica-Bold").fontSize(18).text(r.kind === "amc" ? "AMC Service Report" : "Service Report");
      doc
        .font("Helvetica")
        .fontSize(10)
        .fillColor(signed ? "#166534" : "#92400e")
        .text(signed ? `SIGNED - FINAL (version ${r.version})` : `SUBMITTED - FINAL, NOT SIGNED: customer acknowledgement was not required (version ${r.version})`)
        .fillColor("#000000");
      doc.moveDown(0.8);

      const row = (label: string, value: string | null | undefined) => {
        doc.font("Helvetica-Bold").fontSize(10).text(`${label}: `, { continued: true }).font("Helvetica").text(value && value.trim() ? value : "-");
      };
      row("Report ID", r.reportNumber);
      if (r.kind === "amc" && r.amc) {
        row("AMC order", `${r.amc.orderRef} (PO ${r.amc.poNo}, ${dateOnly(r.amc.poDate)})`);
        row("AMC type", r.amc.typeLabel);
        row("AMC location", r.amc.location);
        row("Contracted visits per year", String(r.amc.frequencyPerYear));
      } else {
        row("Service ticket", r.ticketNumber);
      }
      row("Customer", r.customerName);
      row("Site", [r.siteName, r.siteAddress].filter(Boolean).join(", ") || null);
      row("RECD serial number", r.recdSerial);
      row("RECD model", r.recdModel);
      row("DG", [r.dgModel, r.dgCapacityKva != null ? `${r.dgCapacityKva} kVA` : null].filter(Boolean).join(", ") || null);
      row("Service visit date", dateOnly(r.visitDate));
      row("Engineer", r.engineerName);

      const section = (title: string, body: string | null) => {
        doc.moveDown(0.8).font("Helvetica-Bold").fontSize(12).text(title);
        doc.font("Helvetica").fontSize(10).text(body && body.trim() ? body : "-", { width });
      };
      section("Work performed", r.workPerformed);
      section("Findings / observations", r.findings);
      section("Resolution / outcome", r.resolution);
      if (r.partsUsed) section("Parts used", r.partsUsed);
      if (r.remarks) section("Remarks", r.remarks);

      if (signed) {
        if (!r.signaturePng || !r.signerName || !r.signedAt) throw new Error("A signed report needs the signature image, the signer and the time");
        // Keep the signature block together on one page.
        if (doc.y > doc.page.height - 260) doc.addPage();
        doc.moveDown(1.2).font("Helvetica-Bold").fontSize(12).text("Customer signature");
        doc.moveDown(0.4);
        const boxTop = doc.y;
        doc.rect(50, boxTop, 260, 100).strokeColor("#9ca3af").stroke();
        doc.image(r.signaturePng, 56, boxTop + 4, { fit: [248, 92], align: "center", valign: "center" });
        doc.x = 50;
        doc.y = boxTop + 108;
        row("Signed by", r.signerName);
        row("Signed on", dateTime(r.signedAt));
      } else {
        doc.moveDown(1.2).font("Helvetica-Bold").fontSize(12).text("Customer acknowledgement");
        doc.font("Helvetica").fontSize(10).text("Not required for this report. It carries no customer signature.", { width });
        row("Submitted on", r.submittedAt ? dateTime(r.submittedAt) : null);
      }
      doc
        .moveDown(0.6)
        .font("Helvetica")
        .fontSize(8)
        .fillColor("#6b7280")
        .text(`Document integrity: SHA-256 of the report content at ${signed ? "signing" : "submission"}: ${r.contentHash}`, { width })
        .text(
          signed
            ? "This report was reviewed and signed in the Platino RECD Tracker by the authenticated customer contact named above."
            : "This report was finalised in the Platino RECD Tracker by Platino staff without a customer signature.",
          { width },
        )
        .fillColor("#000000");
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}
