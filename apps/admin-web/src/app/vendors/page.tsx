"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/apiClient";

interface Vendor {
  id: string;
  name: string;
  status: string;
  contactName: string;
  contactEmail: string;
  contactPhone: string | null;
  address: string | null;
  approvedAt: string | null;
  createdAt: string;
  _count: { members: number; sites: number };
}

function statusBadge(status: string) {
  if (status === "approved") return "bg-green-100 text-green-800";
  if (status === "rejected") return "bg-red-100 text-red-800";
  return "bg-amber-100 text-amber-800";
}

export default function VendorsPage() {
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [approval, setApproval] = useState<{ name: string; email: string; tempPassword?: string; created: boolean } | null>(null);

  function load() {
    api<Vendor[]>("/vendors").then(setVendors).catch((e) => setError(e instanceof Error ? e.message : "Failed to load vendors"));
  }
  useEffect(load, []);

  async function approve(v: Vendor) {
    setBusy(v.id);
    setError(null);
    try {
      const res = await api<{ contactLoginCreated: boolean; contactEmail: string; tempPassword?: string }>(`/vendors/${v.id}/approve`, { method: "POST" });
      setApproval({ name: v.name, email: res.contactEmail, tempPassword: res.tempPassword, created: res.contactLoginCreated });
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to approve vendor");
    } finally {
      setBusy(null);
    }
  }

  async function reject(v: Vendor) {
    setBusy(v.id);
    setError(null);
    try {
      await api(`/vendors/${v.id}/reject`, { method: "POST" });
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to reject vendor");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-6 max-w-5xl">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight" style={{ color: "var(--text-heading)" }}>Vendors</h1>
        <p className="mt-1 text-sm text-gray-500">
          External erection subcontractors. Review a registration, run due diligence, then approve — approval creates the vendor&apos;s first engineer login.
        </p>
      </div>

      {error && (
        <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      {approval && (
        <div className="rounded-lg bg-green-50 border border-green-200 px-4 py-3 text-sm text-green-800">
          <p><strong>{approval.name}</strong> approved.</p>
          {approval.created ? (
            <p className="mt-1">
              Login created for <span className="font-mono">{approval.email}</span>
              {approval.tempPassword && (
                <> — temporary password: <code className="rounded bg-green-100 px-2 py-0.5 font-mono font-semibold">{approval.tempPassword}</code></>
              )}
            </p>
          ) : (
            <p className="mt-1">A user with that email already exists, so no new login was created.</p>
          )}
          <button onClick={() => setApproval(null)} className="mt-2 text-xs text-green-700 underline">Dismiss</button>
        </div>
      )}

      {/* ── Vendors table (desktop) ───────────────────────────────────── */}
      <div className="card overflow-hidden table-desktop">
        <div className="table-scroll">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="bg-gray-50 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">
                <th className="px-5 py-3">Vendor</th>
                <th className="px-5 py-3">Contact</th>
                <th className="px-5 py-3">Status</th>
                <th className="px-5 py-3">Engineers</th>
                <th className="px-5 py-3">Sites</th>
                <th className="px-5 py-3 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {vendors.map((v) => (
                <tr key={v.id} className="hover:bg-gray-50/60">
                  <td className="px-5 py-3">
                    <div className="font-medium">{v.name}</div>
                    <div className="text-xs text-gray-400">{v.address ?? "—"}</div>
                  </td>
                  <td className="px-5 py-3">
                    <div>{v.contactName}</div>
                    <div className="text-xs text-gray-400">{v.contactEmail}{v.contactPhone ? ` · ${v.contactPhone}` : ""}</div>
                  </td>
                  <td className="px-5 py-3">
                    <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium capitalize ${statusBadge(v.status)}`}>{v.status}</span>
                  </td>
                  <td className="px-5 py-3 text-gray-600">{v._count.members}</td>
                  <td className="px-5 py-3 text-gray-600">{v._count.sites}</td>
                  <td className="px-5 py-3">
                    <div className="flex items-center justify-end gap-2">
                      {v.status === "pending" ? (
                        <>
                          <button
                            onClick={() => approve(v)}
                            disabled={busy === v.id}
                            className="rounded-lg bg-green-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-700 disabled:opacity-50"
                          >
                            {busy === v.id ? "…" : "Approve"}
                          </button>
                          <button
                            onClick={() => reject(v)}
                            disabled={busy === v.id}
                            className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                          >
                            Reject
                          </button>
                        </>
                      ) : v.status === "rejected" ? (
                        <button
                          onClick={() => approve(v)}
                          disabled={busy === v.id}
                          className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                        >
                          Reconsider
                        </button>
                      ) : (
                        <span className="text-xs text-gray-400">Approved {v.approvedAt ? new Date(v.approvedAt).toLocaleDateString() : ""}</span>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {vendors.length === 0 && (
                <tr><td colSpan={6} className="px-5 py-8 text-center text-gray-400">No vendors registered yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Vendors cards (mobile) ────────────────────────────────────── */}
      <div className="cards-mobile" data-testid="vendors-mobile-cards">
        {vendors.length === 0 ? (
          <div className="card p-6 text-center text-sm text-gray-400">No vendors registered yet.</div>
        ) : (
          vendors.map((v) => (
            <div key={v.id} className="data-card" data-testid={`vendor-card-${v.id}`}>
              <div className="flex items-start justify-between gap-3 mb-2">
                <div className="min-w-0">
                  <p className="font-semibold text-sm text-gray-900 truncate">{v.name}</p>
                  <p className="text-xs text-gray-500 truncate">{v.address ?? "—"}</p>
                </div>
                <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold capitalize whitespace-nowrap ${statusBadge(v.status)}`}>
                  {v.status}
                </span>
              </div>
              <div className="data-card-row">
                <span className="label">Contact</span>
                <span className="value truncate">{v.contactName}</span>
              </div>
              <div className="data-card-row">
                <span className="label">Email</span>
                <span className="value truncate">{v.contactEmail}</span>
              </div>
              {v.contactPhone && (
                <div className="data-card-row">
                  <span className="label">Phone</span>
                  <span className="value">{v.contactPhone}</span>
                </div>
              )}
              <div className="data-card-row">
                <span className="label">Engineers</span>
                <span className="value">{v._count.members}</span>
              </div>
              <div className="data-card-row">
                <span className="label">Sites</span>
                <span className="value">{v._count.sites}</span>
              </div>
              <div className="mt-3 flex items-center gap-2">
                {v.status === "pending" ? (
                  <>
                    <button
                      onClick={() => approve(v)}
                      disabled={busy === v.id}
                      className="flex-1 rounded-lg bg-green-600 px-3 py-2 text-xs font-medium text-white hover:bg-green-700 disabled:opacity-50"
                    >
                      {busy === v.id ? "…" : "Approve"}
                    </button>
                    <button
                      onClick={() => reject(v)}
                      disabled={busy === v.id}
                      className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                    >
                      Reject
                    </button>
                  </>
                ) : v.status === "rejected" ? (
                  <button
                    onClick={() => approve(v)}
                    disabled={busy === v.id}
                    className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                  >
                    Reconsider
                  </button>
                ) : (
                  <span className="text-xs text-gray-400">Approved {v.approvedAt ? new Date(v.approvedAt).toLocaleDateString() : ""}</span>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
