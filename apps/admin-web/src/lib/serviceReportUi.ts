import { SERVICE_REPORT_STATUS } from "@recd/shared";

/** CSS class of the status pill for a service report. */
export function reportStatusPill(status: string): string {
  if (status === SERVICE_REPORT_STATUS.SIGNED) return "status-pill status-pill-success";
  if (status === SERVICE_REPORT_STATUS.AWAITING_SIGNATURE) return "status-pill status-pill-warning";
  // Final but NOT signed: deliberately not the green "signed" look.
  if (status === SERVICE_REPORT_STATUS.SUBMITTED) return "status-pill";
  return "status-pill";
}
