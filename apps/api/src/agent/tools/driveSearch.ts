/** Agent tool: search and read documents in the company's Drive folder (ZanF_DropBox).
 *
 * Two-step by design, same shape as an LLM tool would call it:
 *   1. searchDriveDocuments(query) - cheap, returns matches without downloading content.
 *   2. getDriveDocumentContent(fileId) - fetches + extracts text for one specific file.
 * Keeping these separate avoids downloading/extracting every match just to list results.
 */
import { getDriveClient, getDriveFolderId } from "../../lib/googleDrive";
import { extractText, isExtractable, ExtractionError } from "../../lib/docExtract";

export interface DriveSearchResult {
  fileId: string;
  name: string;
  mimeType: string;
  modifiedTime: string | null | undefined;
  webViewLink: string | null | undefined;
}

/** Google-native docs/sheets need to be exported to a plain format rather than downloaded raw. */
const GOOGLE_EXPORT_MIME: Record<string, string> = {
  "application/vnd.google-apps.document": "text/plain",
  "application/vnd.google-apps.spreadsheet": "text/csv",
};

export async function searchDriveDocuments(query: string, maxResults = 10): Promise<DriveSearchResult[]> {
  const drive = getDriveClient();
  const folderId = getDriveFolderId();

  // fullText search covers document content (not just filenames); scoped to the one folder
  // (non-recursive - Drive's `in parents` only matches direct children) and excludes trash.
  const escapedQuery = query.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const q = `'${folderId}' in parents and trashed = false and fullText contains '${escapedQuery}'`;

  const res = await drive.files.list({
    q,
    fields: "files(id, name, mimeType, modifiedTime, webViewLink)",
    pageSize: maxResults,
  });

  return (res.data.files ?? []).map((f) => ({
    fileId: f.id!,
    name: f.name!,
    mimeType: f.mimeType!,
    modifiedTime: f.modifiedTime,
    webViewLink: f.webViewLink,
  }));
}

/** Lists all documents in the folder without a search filter - useful for browsing / "what's in there". */
export async function listDriveDocuments(maxResults = 50): Promise<DriveSearchResult[]> {
  const drive = getDriveClient();
  const folderId = getDriveFolderId();

  const res = await drive.files.list({
    q: `'${folderId}' in parents and trashed = false`,
    fields: "files(id, name, mimeType, modifiedTime, webViewLink)",
    pageSize: maxResults,
    orderBy: "modifiedTime desc",
  });

  return (res.data.files ?? []).map((f) => ({
    fileId: f.id!,
    name: f.name!,
    mimeType: f.mimeType!,
    modifiedTime: f.modifiedTime,
    webViewLink: f.webViewLink,
  }));
}

export async function getDriveDocumentContent(fileId: string): Promise<{ name: string; mimeType: string; text: string }> {
  const drive = getDriveClient();

  const meta = await drive.files.get({ fileId, fields: "id, name, mimeType" });
  const mimeType = meta.data.mimeType!;
  const name = meta.data.name!;

  if (!isExtractable(mimeType)) {
    throw new ExtractionError(`Unsupported file type: ${mimeType}`);
  }

  const exportMime = GOOGLE_EXPORT_MIME[mimeType];
  const buffer = exportMime
    ? await downloadExport(drive, fileId, exportMime)
    : await downloadRaw(drive, fileId);

  const text = await extractText(buffer, exportMime ?? mimeType);
  return { name, mimeType, text };
}

async function downloadRaw(drive: ReturnType<typeof getDriveClient>, fileId: string): Promise<Buffer> {
  const res = await drive.files.get({ fileId, alt: "media" }, { responseType: "arraybuffer" });
  return Buffer.from(res.data as ArrayBuffer);
}

async function downloadExport(
  drive: ReturnType<typeof getDriveClient>,
  fileId: string,
  exportMimeType: string,
): Promise<Buffer> {
  const res = await drive.files.export({ fileId, mimeType: exportMimeType }, { responseType: "arraybuffer" });
  return Buffer.from(res.data as ArrayBuffer);
}
