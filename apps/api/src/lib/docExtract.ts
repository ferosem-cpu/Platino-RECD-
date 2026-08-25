/** Extracts plain text from a document buffer, given its Drive mimeType.
 *
 * Scope: PDF, DOCX, and plain
 * text/CSV/Markdown. Scanned/image-only PDFs and images are explicitly unsupported (would
 * need OCR, not wired up) - callers should treat a thrown ExtractionError as "not searchable
 * content" rather than a hard failure.
 */
import mammoth from "mammoth";
// pdf-parse is imported lazily inside extractText(), not statically here - importing it
// eagerly at module load crashed the ENTIRE api function on Vercel's Linux runtime, not just
// PDF extraction: pdf-parse tries to load the optional native "@napi-rs/canvas" package for
// rendering, and when that binary isn't available it falls through to a broken DOMMatrix
// polyfill path that throws `ReferenceError: DOMMatrix is not defined` at require-time. Since
// this module sits on the startup import chain (index.ts -> agent routers -> tool registry ->
// driveSearch -> docExtract), that crash took down every route including /health, not just
// document search. A dynamic import scopes the failure to only PDF extraction attempts.

export class ExtractionError extends Error {}

const GOOGLE_DOC_EXPORT_MIME = "application/vnd.google-apps.document";
const GOOGLE_SHEET_EXPORT_MIME = "application/vnd.google-apps.spreadsheet";

export function isExtractable(mimeType: string): boolean {
  return (
    mimeType === "application/pdf" ||
    mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    mimeType === "text/plain" ||
    mimeType === "text/csv" ||
    mimeType === "text/markdown" ||
    mimeType === GOOGLE_DOC_EXPORT_MIME ||
    mimeType === GOOGLE_SHEET_EXPORT_MIME
  );
}

export async function extractText(buffer: Buffer, mimeType: string): Promise<string> {
  if (mimeType === "application/pdf") {
    let PDFParse: typeof import("pdf-parse").PDFParse;
    try {
      ({ PDFParse } = await import("pdf-parse"));
    } catch (err) {
      throw new ExtractionError(
        `PDF extraction is unavailable in this environment: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const parser = new PDFParse({ data: buffer });
    try {
      const result = await parser.getText();
      if (!result.text.trim()) {
        throw new ExtractionError("PDF has no extractable text (likely scanned/image-only - OCR not supported).");
      }
      return result.text;
    } catch (err) {
      if (err instanceof ExtractionError) throw err;
      throw new ExtractionError(
        `PDF extraction failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      await parser.destroy();
    }
  }

  if (mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }

  if (mimeType === "text/plain" || mimeType === "text/csv" || mimeType === "text/markdown") {
    return buffer.toString("utf-8");
  }

  throw new ExtractionError(`Unsupported file type for extraction: ${mimeType}`);
}
