/**
 * Which pages a signed-in CUSTOMER may open besides the portal. This is only the screen guard: every service-report request is
 * authorised again by the API (a customer only ever gets their own customer's reports, and never a draft), so opening these pages
 * grants nothing the customer did not already have.
 *
 *  - /service-reports          the customer's own reports (all of them, or one ticket's via ?complaintId=) - the portal links here
 *  - /service-reports/<id>     one report to review and sign
 */
export function isCustomerReportPath(pathname: string): boolean {
  return /^\/service-reports\/?$/.test(pathname) || /^\/service-reports\/[^/]+\/?$/.test(pathname);
}

/** Permissions that open the staff service-report list (any one is enough). The API still decides which reports a user may see. */
export const SERVICE_REPORT_LIST_PERMISSIONS = ["manage_complaints", "view_complaints_overview", "act_assigned_complaints", "manage_amc_orders"] as const;
