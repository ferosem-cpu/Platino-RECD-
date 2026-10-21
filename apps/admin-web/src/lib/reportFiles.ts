import { apiBlob } from "@/lib/apiClient";

/** Saves a signed report PDF through the browser's download flow, fetched with the login token. */
export async function downloadReportPdf(reportId: string, reportNumber: string): Promise<void> {
  const blob = await apiBlob(`/service-reports/${reportId}/pdf`);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `service-report-${reportNumber}.pdf`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Opens the signed PDF in a new tab. The tab is opened first (inside the click) so pop-up blockers allow it. */
export async function openReportPdf(reportId: string): Promise<void> {
  const tab = window.open("", "_blank");
  try {
    const blob = await apiBlob(`/service-reports/${reportId}/pdf?disposition=inline`);
    const url = URL.createObjectURL(blob);
    if (tab) tab.location.href = url;
    else window.location.href = url;
    setTimeout(() => URL.revokeObjectURL(url), 5 * 60_000);
  } catch (err) {
    tab?.close();
    throw err;
  }
}
