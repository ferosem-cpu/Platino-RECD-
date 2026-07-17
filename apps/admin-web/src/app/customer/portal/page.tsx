"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/components/AuthContext";
import { api } from "@/lib/apiClient";
import { ISSUE_CATEGORY_LABELS } from "@recd/shared";

const ISSUE_CATEGORY_OPTIONS = Object.entries(ISSUE_CATEGORY_LABELS);

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

interface StageDefinition {
  id: string;
  key: string;
  label: string;
  phase: string;
  sequenceOrder: number;
}

interface SiteStageEvent {
  id: string;
  stageDefinition: StageDefinition;
  statusOption: { label: string };
  comment: string;
  createdAt: string;
  createdBy: { name: string };
}

interface SitePhoto {
  id: string;
  checkpoint: { label: string };
  photoUrl: string;
  caption: string | null;
  uploadedAt: string;
}

interface PendingAction {
  id: string;
  category: string;
  description: string;
  status: string;
  dueDate: string | null;
  priority: string;
}

interface SiteDetail {
  id: string;
  address: string | null;
  dgCapacityKva: number | null;
  dgModel: string | null;
  companyName: string | null;
  sitePocName: string | null;
  sitePocNumber: string | null;
  currentStage: StageDefinition;
  order: {
    orderNumber: string;
    quantity: number;
    value: number;
    orderDate: string;
    product: { name: string; model: string };
    customer: { name: string };
  };
  stageEvents: SiteStageEvent[];
  photos: SitePhoto[];
  pendingActions: PendingAction[];
}

interface Complaint {
  id: string;
  ticketNumber: string;
  category: string;
  description: string;
  severity: string;
  status: string;
  createdAt: string;
}

export default function CustomerPortalPage() {
  const { user, logout } = useAuth();
  const [site, setSite] = useState<SiteDetail | null>(null);
  const [stages, setStages] = useState<StageDefinition[]>([]);
  const [complaints, setComplaints] = useState<Complaint[]>([]);
  const [loading, setLoading] = useState(true);

  // New Complaint Form
  const [category, setCategory] = useState("erection_commissioning");
  const [severity, setSeverity] = useState("medium");
  const [issueCategory, setIssueCategory] = useState(ISSUE_CATEGORY_OPTIONS[0][0]);
  const [description, setDescription] = useState("");
  const [complaintRemarks, setComplaintRemarks] = useState("");
  const [attachmentFile, setAttachmentFile] = useState<File | null>(null);
  const [submittingComplaint, setSubmittingComplaint] = useState(false);
  const [complaintSuccess, setComplaintSuccess] = useState<string | null>(null);
  const [complaintError, setComplaintError] = useState<string | null>(null);
  const [resolvingAction, setResolvingAction] = useState<string | null>(null);

  // Company Details Form
  const [companyDetails, setCompanyDetails] = useState({
    companyName: "",
    address: "",
    dgCapacityKva: "",
    dgModel: "",
    sitePocName: "",
    sitePocNumber: "",
  });
  const [savingCompanyDetails, setSavingCompanyDetails] = useState(false);
  const [companyDetailsError, setCompanyDetailsError] = useState<string | null>(null);
  const [companyDetailsSaved, setCompanyDetailsSaved] = useState(false);

  async function loadData() {
    try {
      setLoading(true);
      // Fetch stages
      const stagesData = await api<StageDefinition[]>("/meta/stages");
      setStages(stagesData);

      // Fetch customer sites
      const sitesData = await api<any[]>("/sites");
      if (sitesData.length > 0) {
        // Fetch detailed site view (includes events, photos, pendingActions)
        const detail = await api<SiteDetail>(`/sites/${sitesData[0].id}`);
        setSite(detail);
        setCompanyDetails({
          companyName: detail.companyName ?? "",
          address: detail.address ?? "",
          dgCapacityKva: detail.dgCapacityKva != null ? String(detail.dgCapacityKva) : "",
          dgModel: detail.dgModel ?? "",
          sitePocName: detail.sitePocName ?? "",
          sitePocNumber: detail.sitePocNumber ?? "",
        });
      }

      // Fetch complaints
      const complaintsData = await api<Complaint[]>("/complaints");
      setComplaints(complaintsData);
    } catch (err) {
      console.error("Failed to load customer portal data", err);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadData();
  }, []);

  async function resolvePending(actionId: string, resolution: string) {
    setResolvingAction(actionId);
    try {
      await api(`/pending-actions/${actionId}/resolve`, {
        method: "POST",
        body: JSON.stringify({ resolution }),
      });
      await loadData();
    } catch (err) {
      console.error("Failed to resolve pending action", err);
    } finally {
      setResolvingAction(null);
    }
  }

  async function submitCompanyDetails(e: React.FormEvent) {
    e.preventDefault();
    if (!site) return;
    setSavingCompanyDetails(true);
    setCompanyDetailsError(null);
    setCompanyDetailsSaved(false);
    try {
      await api(`/sites/${site.id}/company-details`, {
        method: "PATCH",
        body: JSON.stringify({
          companyName: companyDetails.companyName,
          address: companyDetails.address,
          dgCapacityKva: parseFloat(companyDetails.dgCapacityKva),
          dgModel: companyDetails.dgModel,
          sitePocName: companyDetails.sitePocName,
          sitePocNumber: companyDetails.sitePocNumber,
        }),
      });
      setCompanyDetailsSaved(true);
      await loadData();
    } catch (err) {
      setCompanyDetailsError(err instanceof Error ? err.message : "Failed to save company details");
    } finally {
      setSavingCompanyDetails(false);
    }
  }

  async function handleComplaintSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!site) return;
    if (!attachmentFile) {
      setComplaintError("Please attach a photo of the RECD & DG Name Plate.");
      return;
    }
    setSubmittingComplaint(true);
    setComplaintSuccess(null);
    setComplaintError(null);

    try {
      const attachmentUrl = await fileToDataUrl(attachmentFile);
      const fullDescription = complaintRemarks
        ? `${description}\n\nRemarks: ${complaintRemarks}`
        : description;
      await api("/complaints", {
        method: "POST",
        body: JSON.stringify({
          siteId: site.id,
          category,
          issueCategory,
          severity,
          description: fullDescription,
          attachmentUrl,
        }),
      });
      setComplaintSuccess("Complaint submitted successfully!");
      setDescription("");
      setComplaintRemarks("");
      setAttachmentFile(null);
      // Reload complaints
      const complaintsData = await api<Complaint[]>("/complaints");
      setComplaints(complaintsData);
    } catch (err) {
      setComplaintError(err instanceof Error ? err.message : "Failed to raise complaint");
    } finally {
      setSubmittingComplaint(false);
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <div className="flex flex-col items-center space-y-4">
          <div className="h-10 w-10 animate-spin rounded-full border-4 border-[var(--theme-accent)] border-t-transparent"></div>
          <p className="text-sm font-medium text-gray-500">Retrieving order details...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 pb-12" data-testid="customer-portal-page">
      {/* ── Top Premium Navbar ─────────────────────────────────────────── */}
      <header className="sticky top-0 z-40 bg-white border-b border-gray-200 px-4 sm:px-6 py-3 sm:py-4 shadow-sm flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="h-8 w-8 rounded-lg bg-[var(--theme-primary)] flex items-center justify-center text-white font-bold text-lg shrink-0">P</div>
          <div className="min-w-0">
            <h1 className="text-sm sm:text-md font-bold text-gray-900 leading-tight truncate">Order Tracking</h1>
            <p className="text-[10px] sm:text-xs text-gray-500 truncate">Customer Support Portal</p>
          </div>
        </div>

        <div className="flex items-center gap-2 sm:gap-4 shrink-0">
          <div className="text-right hidden sm:block">
            <p className="text-xs font-semibold text-gray-900">{user?.name}</p>
            <p className="text-[10px] text-gray-500">{site?.order?.customer?.name}</p>
          </div>
          <button
            onClick={logout}
            data-testid="portal-signout-button"
            className="rounded-lg border border-gray-200 hover:border-red-200 px-2.5 sm:px-3.5 py-1.5 text-xs font-semibold text-gray-600 hover:text-red-600 hover:bg-red-50 transition-all flex items-center gap-1.5"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 9V5.25A2.25 2.25 0 0013.5 3h-6a2.25 2.25 0 00-2.25 2.25v13.5A2.25 2.25 0 007.5 21h6a2.25 2.25 0 002.25-2.25V15m3 0l3-3m0 0l-3-3m3 3H9" />
            </svg>
            <span className="hidden xs:inline sm:inline">Sign Out</span>
          </button>
        </div>
      </header>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 mt-6 sm:mt-8 grid grid-cols-1 lg:grid-cols-3 gap-6 lg:gap-8">
        
        {/* Left 2 Columns: Tracking and Timeline */}
        <div className="lg:col-span-2 space-y-8">
          
          {/* Order Details Banner */}
          {site ? (
            <div className="card p-6 border-l-4 border-[var(--theme-accent)]">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <span className="badge badge-accent mb-2">Order Confirmed</span>
                  <h2 className="text-xl font-bold tracking-tight">{site.order.product.name}</h2>
                  <p className="text-xs text-gray-500 mt-1">Model: {site.order.product.model} | Capacity: {site.dgCapacityKva ?? site.order.product.model.match(/\d+/)?.[0]} kVA</p>
                </div>
                <div className="text-right">
                  <p className="text-xs font-semibold text-gray-500">RECD Serial Number</p>
                  <p className="text-base font-bold font-mono text-[var(--theme-primary)]">{site.order.orderNumber}</p>
                  <p className="text-xs text-gray-400 mt-1">Date: {new Date(site.order.orderDate).toLocaleDateString()}</p>
                </div>
              </div>

              <div className="mt-6 grid grid-cols-2 sm:grid-cols-4 gap-4 border-t border-gray-100 pt-6">
                <div>
                  <p className="text-[10px] uppercase font-bold tracking-wider text-gray-400">Status</p>
                  <p className="text-sm font-semibold mt-1" style={{ color: "var(--theme-accent)" }}>{site.currentStage.label}</p>
                </div>
                <div>
                  <p className="text-[10px] uppercase font-bold tracking-wider text-gray-400">Qty</p>
                  <p className="text-sm font-semibold mt-1">{site.order.quantity} Set</p>
                </div>
                <div>
                  <p className="text-[10px] uppercase font-bold tracking-wider text-gray-400">Dispatch Location</p>
                  <p className="text-sm font-semibold mt-1 truncate" title={site.address ?? ""}>{site.address ?? "Not specified"}</p>
                </div>
                <div>
                  <p className="text-[10px] uppercase font-bold tracking-wider text-gray-400">Support Owner</p>
                  <p className="text-sm font-semibold mt-1">Platino Ops Team</p>
                </div>
              </div>
            </div>
          ) : (
            <div className="card p-8 text-center text-gray-500">
              No orders found for this account.
            </div>
          )}

          {/* Action needed from the customer (e.g. exhaust hookup decision) */}
          {site && site.pendingActions.filter((p) => p.status === "open").length > 0 && (
            <section className="card p-6 border-l-4 border-amber-400 bg-amber-50/40">
              <h3 className="text-lg font-bold mb-1 text-amber-900">Action needed from you</h3>
              <p className="text-xs text-amber-800/80 mb-4">Please review and respond so our team can proceed on site.</p>
              <div className="space-y-4">
                {site.pendingActions
                  .filter((p) => p.status === "open")
                  .map((p) => (
                    <div key={p.id} className="rounded-xl border border-amber-200 bg-white p-4">
                      <p className="text-sm text-gray-700">{p.description}</p>
                      {p.category === "customer_approval" && (
                        <div className="mt-3 flex flex-wrap gap-2">
                          <button
                            disabled={resolvingAction === p.id}
                            onClick={() => resolvePending(p.id, "keep_existing")}
                            className="rounded-lg border border-gray-300 px-3 py-2 text-xs font-semibold hover:bg-gray-50 disabled:opacity-50"
                          >
                            Keep my existing exhaust filter
                          </button>
                          <button
                            disabled={resolvingAction === p.id}
                            onClick={() => resolvePending(p.id, "replace_with_recd")}
                            className="btn-primary px-3 py-2 text-xs font-semibold disabled:opacity-50"
                          >
                            Remove it &amp; install the RECD
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
              </div>
            </section>
          )}

          {/* SITC Installation Stage Timeline */}
          {site && (
            <section className="card p-6">
              <h3 className="text-lg font-bold mb-6">Delivery & Installation Progress</h3>
              
              {/* Progress Line */}
              <div className="relative pl-6 space-y-6 before:absolute before:left-[11px] before:top-2 before:bottom-2 before:w-[2px] before:bg-gray-200">
                {stages.map((st) => {
                  const isCurrent = site.currentStage.key === st.key;
                  const isCompleted = st.sequenceOrder <= site.currentStage.sequenceOrder;
                  
                  return (
                    <div key={st.key} className="relative flex gap-4">
                      {/* Circle indicator */}
                      <div className={`absolute -left-[21px] mt-1.5 h-4 w-4 rounded-full border-2 bg-white flex items-center justify-center transition-all ${
                        isCurrent
                          ? "border-[var(--theme-accent)] ring-4 ring-[var(--theme-accent)]/20"
                          : isCompleted
                          ? "border-[var(--theme-primary)] bg-[var(--theme-primary)]"
                          : "border-gray-300"
                      }`}>
                        {isCompleted && !isCurrent && (
                          <svg className="w-2.5 h-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                          </svg>
                        )}
                      </div>

                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between">
                          <p className={`text-sm font-semibold ${isCurrent ? "text-[var(--theme-accent)]" : isCompleted ? "text-gray-900" : "text-gray-400"}`}>
                            {st.label}
                          </p>
                          <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                            isCurrent
                              ? "bg-amber-100 text-amber-800 animate-pulse"
                              : isCompleted
                              ? "bg-emerald-50 text-emerald-700"
                              : "bg-gray-100 text-gray-400"
                          }`}>
                            {st.phase}
                          </span>
                        </div>
                        {isCurrent && (
                          <div className="mt-2 text-xs text-gray-600 bg-amber-50/50 rounded-xl p-3 border border-amber-100/50">
                            Our team is currently working on this phase. Check back later for updates.
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {/* Stage Event History */}
          {site && site.stageEvents.length > 0 && (
            <section className="card p-6">
              <h3 className="text-lg font-bold mb-4">Milestone History</h3>
              <div className="space-y-4 divide-y divide-gray-100">
                {site.stageEvents.map((ev, idx) => (
                  <div key={ev.id} className={`pt-4 ${idx === 0 ? "pt-0" : ""}`}>
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-semibold text-gray-900">{ev.stageDefinition.label}</p>
                      <span className="text-[10px] text-gray-400">{new Date(ev.createdAt).toLocaleString()}</span>
                    </div>
                    <p className="text-xs text-emerald-700 font-medium mt-1">Status: {ev.statusOption.label}</p>
                    {ev.comment && (
                      <p className="text-xs text-gray-500 bg-gray-50 rounded-lg p-2.5 mt-2 italic border border-gray-100">
                        "{ev.comment}"
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Photo Gallery */}
          {site && site.photos.length > 0 && (
            <section className="card p-6">
              <h3 className="text-lg font-bold mb-4">Installation Gallery</h3>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
                {site.photos.map((p) => (
                  <div key={p.id} className="group relative rounded-xl border border-gray-200 overflow-hidden bg-gray-50 aspect-square flex flex-col">
                    <img
                      src={p.photoUrl}
                      alt={p.caption || "Installation checkpoint"}
                      className="flex-1 object-cover hover:scale-105 transition-transform duration-300"
                    />
                    <div className="p-2 border-t bg-white">
                      <p className="text-[10px] font-bold truncate text-gray-700">{p.checkpoint.label}</p>
                      {p.caption && <p className="text-[9px] text-gray-500 truncate mt-0.5">{p.caption}</p>}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>

        {/* Right Column: Company Details, Support and Complaints */}
        <div className="space-y-8">

          {/* Company Details Form */}
          {site && (
            <section className="card p-6 border border-gray-200">
              <h3 className="text-md font-bold mb-1">Company Details</h3>
              <p className="text-xs text-gray-500 mb-4">
                RECD Serial Number: <span className="font-mono font-semibold text-[var(--theme-primary)]">{site.order.orderNumber}</span>{" "}
                <span className="text-gray-400">(auto-filled after login)</span>
              </p>

              <form onSubmit={submitCompanyDetails} className="space-y-3">
                <div>
                  <label className="block text-xs font-semibold text-gray-500 uppercase mb-1">Company Name *</label>
                  <input required className="field w-full" placeholder="Enter Company Name" value={companyDetails.companyName} onChange={(e) => setCompanyDetails({ ...companyDetails, companyName: e.target.value })} />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-gray-500 uppercase mb-1">Address *</label>
                  <input required className="field w-full" placeholder="Enter Address" value={companyDetails.address} onChange={(e) => setCompanyDetails({ ...companyDetails, address: e.target.value })} />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-semibold text-gray-500 uppercase mb-1">KVA *</label>
                    <input required type="number" min={0} step="0.01" className="field w-full" placeholder="Enter KVA" value={companyDetails.dgCapacityKva} onChange={(e) => setCompanyDetails({ ...companyDetails, dgCapacityKva: e.target.value })} />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-gray-500 uppercase mb-1">RECD Model *</label>
                    <input required className="field w-full" placeholder="Enter RECD Model" value={companyDetails.dgModel} onChange={(e) => setCompanyDetails({ ...companyDetails, dgModel: e.target.value })} />
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-gray-500 uppercase mb-1">Site POC Name *</label>
                  <input required className="field w-full" placeholder="Enter Site POC Name" value={companyDetails.sitePocName} onChange={(e) => setCompanyDetails({ ...companyDetails, sitePocName: e.target.value })} />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-gray-500 uppercase mb-1">Site POC Number *</label>
                  <input required className="field w-full" placeholder="Enter Site POC Number" value={companyDetails.sitePocNumber} onChange={(e) => setCompanyDetails({ ...companyDetails, sitePocNumber: e.target.value })} />
                </div>
                <p className="text-[11px] text-red-500">* All fields are mandatory.</p>

                {companyDetailsError && <div className="rounded-lg bg-red-50 p-3 text-xs text-red-700">{companyDetailsError}</div>}
                {companyDetailsSaved && <div className="rounded-lg bg-green-50 p-3 text-xs text-green-700">Company details saved.</div>}

                <button type="submit" disabled={savingCompanyDetails} className="w-full btn-primary py-2 text-sm font-semibold disabled:opacity-50">
                  {savingCompanyDetails ? "Saving…" : "Save company details"}
                </button>
              </form>
            </section>
          )}

          {/* Complaint Ticket Form */}
          <section className="card p-6">
            <h3 className="text-md font-bold mb-2">Complaint Ticket</h3>
            <p className="text-xs text-gray-500 mb-4">Encountered an issue? Raise a complaint, and our service team will contact you.</p>

            <form onSubmit={handleComplaintSubmit} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-gray-500 uppercase mb-1">Complaint Type *</label>
                <select
                  required
                  className="field w-full"
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                >
                  <option value="erection_commissioning">Erection & Commissioning</option>
                  <option value="delivery_delay">Delivery Delay</option>
                  <option value="non_performance">Performance & Technical Issue</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-500 uppercase mb-1">Urgency *</label>
                <select
                  required
                  className="field w-full"
                  value={severity}
                  onChange={(e) => setSeverity(e.target.value)}
                >
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                  <option value="critical">Critical</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-500 uppercase mb-1">Issue Category *</label>
                <select
                  required
                  className="field w-full"
                  value={issueCategory}
                  onChange={(e) => setIssueCategory(e.target.value)}
                >
                  {ISSUE_CATEGORY_OPTIONS.map(([key, label]) => (
                    <option key={key} value={key}>{label}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-500 uppercase mb-1">Issue Details / Description *</label>
                <textarea
                  required
                  rows={3}
                  placeholder="Please provide detailed information about the issue..."
                  className="field w-full"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-500 uppercase mb-1">Remarks</label>
                <textarea
                  rows={2}
                  placeholder="Add any additional remarks (optional)..."
                  className="field w-full"
                  value={complaintRemarks}
                  onChange={(e) => setComplaintRemarks(e.target.value)}
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-500 uppercase mb-1">Attachment (Photo is mandatory) *</label>
                <input
                  required
                  type="file"
                  accept="image/*"
                  className="field w-full text-xs"
                  onChange={(e) => setAttachmentFile(e.target.files?.[0] ?? null)}
                />
                <p className="mt-1 text-[10px] text-gray-400">
                  Only image files are accepted and must be clear and readable. Please attach RECD & DG Name Plate.
                </p>
              </div>

              {complaintSuccess && (
                <div className="rounded-lg bg-green-50 p-3 text-xs text-green-700">
                  {complaintSuccess}
                </div>
              )}
              {complaintError && (
                <div className="rounded-lg bg-red-50 p-3 text-xs text-red-700">
                  {complaintError}
                </div>
              )}

              <button
                type="submit"
                disabled={submittingComplaint}
                className="w-full btn-primary py-2 text-sm font-semibold disabled:opacity-50"
              >
                {submittingComplaint ? "Submitting..." : "Submit Complaint"}
              </button>
            </form>
          </section>

          {/* Active Support Tickets */}
          <section className="card p-6">
            <h3 className="text-md font-bold mb-4">Support History</h3>
            <div className="space-y-4 max-h-[400px] overflow-y-auto pr-1">
              {complaints.map((c) => (
                <div key={c.id} className="rounded-xl border border-gray-100 p-3.5 bg-white space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-xs font-bold text-[var(--theme-primary)]">{c.ticketNumber}</span>
                    <span className={`status-pill ${
                      c.status === "open" || c.status === "escalated"
                        ? "status-pill-error"
                        : c.status === "resolved" || c.status === "closed"
                        ? "status-pill-success"
                        : "status-pill-warning"
                    }`}>
                      {c.status.toUpperCase()}
                    </span>
                  </div>
                  <p className="text-xs text-gray-700 font-medium">{c.description}</p>
                  <div className="flex justify-between items-center text-[10px] text-gray-400 pt-1 border-t border-gray-50">
                    <span>Severity: <strong className="text-gray-500">{c.severity}</strong></span>
                    <span>{new Date(c.createdAt).toLocaleDateString()}</span>
                  </div>
                </div>
              ))}

              {complaints.length === 0 && (
                <p className="text-xs text-gray-400 text-center py-6">No support tickets raised yet.</p>
              )}
            </div>
          </section>
        </div>

      </div>
    </div>
  );
}
