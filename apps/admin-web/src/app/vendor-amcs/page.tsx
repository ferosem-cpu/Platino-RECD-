"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/apiClient";
import { apiErrorMessage } from "@/lib/apiError";
import { contractStatusLabel, contractStatusPill, daysText, formatDay } from "@/lib/amcUi";
import { EditDialog, HistoryDialog, RenewDialog, type ContractTarget } from "@/components/AmcContractDialogs";

interface VendorAmcRow {
  id: string;
  vendorId: string;
  vendor: { id: string; name: string };
  contractRef: string | null;
  title: string;
  notes: string | null;
  /** The customer and site the vendor's support applies to; both null for a general agreement with the vendor. */
  customer: { id: string; name: string } | null;
  site: { id: string; companyName: string | null } | null;
  startDate: string;
  endDate: string;
  contractStatus: "upcoming" | "renewed" | "active" | "expiring_soon" | "expired";
  daysRemaining: number;
  renewalCount: number;
  expiryReminderClearedAt: string | null;
}

interface VendorOption {
  id: string;
  name: string;
  status: string;
}

interface CustomerOption {
  id: string;
  name: string;
}

interface SiteOption {
  id: string;
  name: string;
}

const EMPTY_FORM = { vendorId: "", customerId: "", siteId: "", contractRef: "", title: "", notes: "", startDate: "", endDate: "", durationMonths: "" };

/** Vendor AMC agreements: separate from the customer AMC orders, tied to an approved Vendor, with renewal history. */
export default function VendorAmcsPage() {
  const [rows, setRows] = useState<VendorAmcRow[]>([]);
  const [vendors, setVendors] = useState<VendorOption[]>([]);
  const [customers, setCustomers] = useState<CustomerOption[]>([]);
  const [siteOptions, setSiteOptions] = useState<SiteOption[]>([]);
  const [counts, setCounts] = useState<{ upcoming: number; renewed: number; active: number; expiringSoon: number; expired: number } | null>(null);
  const [defaultMonths, setDefaultMonths] = useState(12);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [dialog, setDialog] = useState<{ kind: "renew" | "edit" | "history"; row: VendorAmcRow } | null>(null);

  function load() {
    api<{ contracts: VendorAmcRow[]; contractCounts: typeof counts; policy: { durationMonths: number } }>("/vendor-amcs")
      .then((d) => {
        setRows(d.contracts);
        setCounts(d.contractCounts);
        setDefaultMonths(d.policy.durationMonths);
        setError(null);
      })
      .catch((err) => setError(apiErrorMessage(err, "Failed to load vendor AMC contracts")))
      .finally(() => setLoading(false));
    api<VendorOption[]>("/vendors").then((v) => setVendors(v.filter((x) => x.status === "approved"))).catch(() => {});
    api<CustomerOption[]>("/customers").then(setCustomers).catch(() => {}); // optional: without access the contract is simply a general one
  }
  useEffect(load, []);

  // The sites a customer has are those of its RECD units (the same source the customer AMC form uses).
  useEffect(() => {
    setSiteOptions([]);
    if (!form.customerId) return;
    let live = true;
    api<Array<{ site: { id: string; companyName: string | null } | null }>>(`/recd-units?customerId=${encodeURIComponent(form.customerId)}`)
      .then((units) => {
        if (!live) return;
        const byId = new Map<string, string>();
        for (const u of units) if (u.site) byId.set(u.site.id, u.site.companyName ?? "Not set");
        setSiteOptions([...byId].map(([id, name]) => ({ id, name })));
      })
      .catch(() => {});
    return () => { live = false; };
  }, [form.customerId]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    setFormError(null);
    try {
      await api("/vendor-amcs", {
        method: "POST",
        body: JSON.stringify({
          vendorId: form.vendorId,
          title: form.title,
          startDate: form.startDate,
          ...(form.customerId ? { customerId: form.customerId } : {}),
          ...(form.customerId && form.siteId ? { siteId: form.siteId } : {}),
          ...(form.contractRef ? { contractRef: form.contractRef } : {}),
          ...(form.notes ? { notes: form.notes } : {}),
          ...(form.endDate ? { endDate: form.endDate } : form.durationMonths ? { durationMonths: Number(form.durationMonths) } : {}),
        }),
      });
      setCreateOpen(false);
      setForm(EMPTY_FORM);
      setNotice("Vendor AMC contract created.");
      load();
    } catch (err) {
      setFormError(apiErrorMessage(err, "Failed to create the contract"));
    } finally {
      setSaving(false);
    }
  }

  async function markAcquired(id: string) {
    if (!confirm("Mark this vendor AMC as acquired/renewed? This stops the expiry reminders for it.")) return;
    try {
      await api(`/vendor-amcs/${id}/clear-reminder`, { method: "PATCH" });
      load();
    } catch (err) {
      setError(apiErrorMessage(err, "Failed to clear the reminder"));
    }
  }

  const target = (r: VendorAmcRow): ContractTarget => ({ id: r.id, label: r.contractRef || r.title, startDate: r.startDate, endDate: r.endDate });
  function dialogDone(msg: string) {
    setDialog(null);
    setNotice(msg);
    load();
  }

  return (
    <div className="space-y-6 max-w-6xl" data-testid="vendor-amcs-page">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-semibold tracking-tight" style={{ color: "var(--text-heading)" }}>Vendor AMC</h1>
          <p className="mt-1 text-sm text-gray-500">AMC agreements with our vendors - separate from customer AMC orders.</p>
        </div>
        <button onClick={() => setCreateOpen(true)} className="btn-primary px-4 py-2 text-sm" data-testid="vendor-amc-new-button">+ New vendor AMC</button>
      </div>

      {error && <p role="alert" className="text-sm text-red-600" data-testid="vendor-amc-error">{error}</p>}
      {notice && <p role="status" className="text-sm text-emerald-700 bg-emerald-50 rounded-lg px-3 py-2" data-testid="vendor-amc-notice">{notice}</p>}

      {counts && (
        <div className="flex flex-wrap gap-2 text-xs" data-testid="vendor-amc-counts">
          <span className="status-pill">Upcoming {counts.upcoming}</span>
          <span className="status-pill status-pill-success">Renewed {counts.renewed}</span>
          <span className="status-pill status-pill-success">Active {counts.active}</span>
          <span className="status-pill status-pill-warning">Expiring soon {counts.expiringSoon}</span>
          <span className="status-pill status-pill-error">Expired {counts.expired}</span>
        </div>
      )}

      <div className="card overflow-hidden">
        <div className="table-scroll">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="bg-gray-50 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">
                <th className="px-4 py-3">Vendor</th>
                <th className="px-4 py-3">Contract</th>
                <th className="px-4 py-3">Customer / site</th>
                <th className="px-4 py-3">Start</th>
                <th className="px-4 py-3">Expiry</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.map((r) => (
                <tr key={r.id} className="hover:bg-gray-50/60" data-testid={`vendor-amc-row-${r.title}`}>
                  <td className="px-4 py-3">{r.vendor.name}</td>
                  <td className="px-4 py-3"><div className="font-medium">{r.title}</div>{r.contractRef && <div className="font-mono text-xs text-gray-500">{r.contractRef}</div>}</td>
                  <td className="px-4 py-3" data-testid={`vendor-amc-where-${r.title}`}>
                    {r.customer ? <><div>{r.customer.name}</div><div className="text-xs text-gray-500">{r.site ? (r.site.companyName ?? "Not set") : "All sites"}</div></> : <span className="text-gray-400">General agreement</span>}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap">{formatDay(r.startDate)}</td>
                  <td className="px-4 py-3 whitespace-nowrap">{formatDay(r.endDate)}</td>
                  <td className="px-4 py-3">
                    <span className={contractStatusPill(r.contractStatus)}>{contractStatusLabel(r.contractStatus)}</span>
                    <div className="text-[10px] text-gray-500 mt-0.5">{daysText(r.contractStatus, r.daysRemaining)}</div>
                    {r.expiryReminderClearedAt && <span className="text-[10px] font-semibold text-emerald-600">AMC Acquired</span>}
                    {r.renewalCount > 0 && <div className="text-[10px] text-gray-500">{r.renewalCount} renewal/change{r.renewalCount === 1 ? "" : "s"}</div>}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex flex-wrap items-center justify-end gap-2">
                      <button onClick={() => setDialog({ kind: "renew", row: r })} className="rounded-lg border border-indigo-300 px-3 py-1.5 text-xs font-medium text-indigo-700 hover:bg-indigo-50" data-testid={`vendor-amc-renew-${r.title}`}>Renew</button>
                      <button onClick={() => setDialog({ kind: "edit", row: r })} className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50">Edit</button>
                      <button onClick={() => setDialog({ kind: "history", row: r })} className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50" data-testid={`vendor-amc-history-${r.title}`}>History</button>
                      {!r.expiryReminderClearedAt && <button onClick={() => markAcquired(r.id)} className="rounded-lg border border-emerald-300 px-3 py-1.5 text-xs font-medium text-emerald-700 hover:bg-emerald-50">AMC Acquired</button>}
                    </div>
                  </td>
                </tr>
              ))}
              {loading && <tr><td colSpan={7} className="px-4 py-12 text-center text-gray-400" data-testid="vendor-amc-loading">Loading vendor AMC contracts…</td></tr>}
              {!loading && rows.length === 0 && (
                <tr><td colSpan={7} className="px-4 py-12 text-center text-gray-400">No vendor AMC contracts yet.<br /><span className="text-xs">Create one to start tracking its dates and renewals.</span></td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {createOpen && (
        <div className="modal-backdrop" onClick={() => setCreateOpen(false)}>
          <div className="modal-panel" role="dialog" aria-label="New vendor AMC" data-testid="vendor-amc-create-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-lg font-semibold">New vendor AMC</h3>
              <button onClick={() => setCreateOpen(false)} aria-label="Close" className="text-gray-400 hover:text-gray-600">✕</button>
            </div>
            <form onSubmit={submit} className="space-y-3">
              <label className="block text-xs font-medium text-gray-500">Vendor
                <select required className="field w-full mt-1" value={form.vendorId} onChange={(e) => setForm({ ...form, vendorId: e.target.value })} data-testid="vendor-amc-vendor">
                  <option value="">Select an approved vendor</option>
                  {vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
                </select>
              </label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <label className="block text-xs font-medium text-gray-500">Customer (optional)
                  <select className="field w-full mt-1" value={form.customerId} onChange={(e) => setForm({ ...form, customerId: e.target.value, siteId: "" })} data-testid="vendor-amc-customer">
                    <option value="">General agreement (no customer)</option>
                    {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </label>
                <label className="block text-xs font-medium text-gray-500">Site (optional)
                  <select className="field w-full mt-1" disabled={!form.customerId} value={form.siteId} onChange={(e) => setForm({ ...form, siteId: e.target.value })} data-testid="vendor-amc-site">
                    <option value="">All of the customer&apos;s sites</option>
                    {siteOptions.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </label>
              </div>
              <label className="block text-xs font-medium text-gray-500">Title
                <input required maxLength={200} className="field w-full mt-1" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} data-testid="vendor-amc-title" />
              </label>
              <label className="block text-xs font-medium text-gray-500">Vendor&apos;s reference (optional)
                <input maxLength={100} className="field w-full mt-1" value={form.contractRef} onChange={(e) => setForm({ ...form, contractRef: e.target.value })} data-testid="vendor-amc-ref" />
              </label>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <label className="block text-xs font-medium text-gray-500">Start date
                  <input required type="date" className="field w-full mt-1" value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} data-testid="vendor-amc-start" />
                </label>
                <label className="block text-xs font-medium text-gray-500">End date
                  <input type="date" className="field w-full mt-1" value={form.endDate} onChange={(e) => setForm({ ...form, endDate: e.target.value })} data-testid="vendor-amc-end" />
                </label>
                <label className="block text-xs font-medium text-gray-500">or Duration (months)
                  <input type="number" min={1} max={120} className="field w-full mt-1" placeholder={String(defaultMonths)} value={form.durationMonths} onChange={(e) => setForm({ ...form, durationMonths: e.target.value })} disabled={!!form.endDate} data-testid="vendor-amc-duration" />
                </label>
              </div>
              <label className="block text-xs font-medium text-gray-500">Notes (optional)
                <input maxLength={1000} className="field w-full mt-1" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
              </label>
              {formError && <p role="alert" className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2" data-testid="vendor-amc-form-error">{formError}</p>}
              <div className="flex justify-end gap-3">
                <button type="button" onClick={() => setCreateOpen(false)} className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">Cancel</button>
                <button type="submit" disabled={saving} className="btn-primary px-4 py-2 text-sm" data-testid="vendor-amc-submit">{saving ? "Creating…" : "Create contract"}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {dialog?.kind === "renew" && <RenewDialog target={target(dialog.row)} basePath="/vendor-amcs" defaultMonths={defaultMonths} onClose={() => setDialog(null)} onDone={dialogDone} />}
      {dialog?.kind === "history" && <HistoryDialog target={target(dialog.row)} basePath="/vendor-amcs" onClose={() => setDialog(null)} />}
      {dialog?.kind === "edit" && (
        <EditDialog
          target={target(dialog.row)}
          basePath="/vendor-amcs"
          fields={[
            { key: "title", label: "Title", value: dialog.row.title, required: true },
            { key: "contractRef", label: "Vendor's reference", value: dialog.row.contractRef ?? "" },
            { key: "notes", label: "Notes", value: dialog.row.notes ?? "" },
          ]}
          onClose={() => setDialog(null)}
          onDone={dialogDone}
        />
      )}
    </div>
  );
}
