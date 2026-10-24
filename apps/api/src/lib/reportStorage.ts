/**
 * Where signed-report files (the signature PNG and the final PDF) are kept.
 *
 * Only the "database" provider is implemented: the bytes live in the ReportFile table - persistent, covered by the
 * same backups as everything else, and kept out of every complaint / report list query. There is NO S3 (or other
 * object-storage) provider in this project: the S3_* names in .env.example are placeholders that nothing reads.
 * REPORT_STORAGE=database (default) is the only value that works; any other value makes the service-report file
 * features answer 503 "storage not configured" rather than pretending. A different provider (object storage, Google
 * Drive) can be added behind this interface once the mentor / database owner approves one.
 *
 * `put` stores bytes and returns a reference; the caller records the reference only AFTER the put succeeded and
 * removes the object with `delete` if a later step fails, so a failed signing leaves no usable half-state.
 */
import { createHash } from "crypto";
import { prisma } from "./prisma";

export interface StoredFileInfo {
  ref: string;
  sha256: string;
  size: number;
}

export interface ReportStorage {
  readonly name: string;
  put(bytes: Buffer, contentType: string): Promise<StoredFileInfo>;
  /** The bytes, or null when the object does not exist. */
  get(ref: string): Promise<{ bytes: Buffer; contentType: string; sha256: string } | null>;
  delete(ref: string): Promise<void>;
}

export const sha256Hex = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

class DatabaseReportStorage implements ReportStorage {
  readonly name = "database";
  async put(bytes: Buffer, contentType: string): Promise<StoredFileInfo> {
    const sha256 = sha256Hex(bytes);
    const row = await prisma.reportFile.create({ data: { contentType, size: bytes.length, sha256, data: bytes }, select: { id: true } });
    return { ref: row.id, sha256, size: bytes.length };
  }
  async get(ref: string) {
    const row = await prisma.reportFile.findUnique({ where: { id: ref } });
    return row ? { bytes: Buffer.from(row.data), contentType: row.contentType, sha256: row.sha256 } : null;
  }
  async delete(ref: string): Promise<void> {
    await prisma.reportFile.deleteMany({ where: { id: ref } });
  }
}

let override: ReportStorage | null | undefined;
/** Test hook: replace (or, with null, disable) the provider. */
export function setReportStorageForTests(storage: ReportStorage | null | undefined) {
  override = storage;
}

/** The configured provider, or null when REPORT_STORAGE names one that is not implemented. */
export function getReportStorage(env: NodeJS.ProcessEnv = process.env): ReportStorage | null {
  if (override !== undefined) return override;
  const wanted = (env.REPORT_STORAGE || "database").toLowerCase();
  return wanted === "database" ? new DatabaseReportStorage() : null;
}
