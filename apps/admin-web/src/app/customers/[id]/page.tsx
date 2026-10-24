"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { api } from "@/lib/apiClient";
import { mobileOrNone } from "@/lib/contactDisplay";
import { useAuth } from "@/components/AuthContext";

interface CustomerSite {
  id: string;
  orderNumber: string;
  poNumber: string | null;
  poDuplicateFlag: boolean;
  product: { name: string; model: string };
  site: {
    id: string;
    address: string | null;
    companyName: string | null;
    currentStage: { label: string };
    assignedEngineer: { name: string } | null;
    vendor: { name: string } | null;
  } | null;
}

interface CustomerDetail {
  id: string;
  name: string;
  address: string | null;
  contacts: { id: string; name: string; phone: string | null; email: string | null }[];
  orders: CustomerSite[];
}

export default function CustomerDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { hasPermission } = useAuth();
  const canManage = hasPermission("manage_orders");

  const [customer, setCustomer] = useState<CustomerDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(() => {
    if (!id) return;
    setError(null);
    api<CustomerDetail>(`/customers/${id}`).then(setCustomer).catch((e) => setError(e instanceof Error ? e.message : "Failed to load customer"));
  }, [id]);

  useEffect(load, [load]);

  async function remove() {
    if (!customer) return;
    if (!window.confirm(`Delete customer "${customer.name}"? This cannot be undone.`)) return;
    setDeleting(true);
    setError(null);
    try {
      await api(`/customers/${id}`, { method: "DELETE" });
      router.push("/customers");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete customer");
      setDeleting(false);
    }
  }

  if (error && !customer) return <p className="text-sm text-red-600">{error}</p>;
  if (!customer) return <p className="text-sm text-gray-500">Loading...</p>;

  const contact = customer.contacts[0];
  const sitesCount = customer.orders.filter((o) => o.site).length;

  return (
    <div className="space-y-6 max-w-4xl" data-testid="customer-detail-page">
      <div className="flex items-start justify-between gap-3">
        <div>
          <Link href="/customers" className="text-xs font-medium text-gray-400 hover:text-gray-600">← Customers</Link>
          <h1 className="text-xl sm:text-2xl font-semibold" style={{ color: "var(--text-heading)" }}>{customer.name}</h1>
          <p className="text-sm text-gray-500">{sitesCount} site{sitesCount === 1 ? "" : "s"} · {customer.orders.length} order{customer.orders.length === 1 ? "" : "s"}</p>
        </div>
        {canManage && (
          <div className="flex gap-2 shrink-0">
            <Link
              href={`/customers?edit=${customer.id}`}
              className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 whitespace-nowrap"
            >
              Edit
            </Link>
            <button
              type="button"
              onClick={remove}
              disabled={deleting}
              className="rounded-lg border border-red-200 px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50 whitespace-nowrap"
            >
              {deleting ? "Deleting…" : "Delete"}
            </button>
          </div>
        )}
      </div>

      {error && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-700">{error}</div>}

      <section className="card p-5 space-y-2">
        <h2 className="text-sm font-semibold">Customer details</h2>
        <p className="text-sm text-gray-500 whitespace-pre-line">{customer.address ?? "No address on file"}</p>
        {contact && (
          <p className="text-xs text-gray-500 pt-1">
            Contact: {contact.name} · {mobileOrNone(contact.phone)}{contact.email && <> · {contact.email}</>}
          </p>
        )}
      </section>

      <section>
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-medium text-gray-600">Sites for {customer.name}</h2>
          {canManage && (
            <Link href={`/orders?customer=${customer.id}`} className="text-xs font-medium text-[var(--theme-accent)] whitespace-nowrap">
              + Add site
            </Link>
          )}
        </div>
        {customer.orders.length === 0 && <p className="text-sm text-gray-400">No orders or sites for this customer yet.</p>}
        {customer.orders.length > 0 && (
          <div className="cards-mobile sm:grid sm:grid-cols-2 sm:gap-3 sm:space-y-0">
            {customer.orders.map((o) => (
              <div key={o.id} className="data-card">
                <div className="flex items-start justify-between gap-3 mb-2">
                  <Link href={`/orders/${o.id}`} className="font-mono text-xs font-semibold hover:underline" style={{ color: "var(--theme-primary)" }}>
                    {o.orderNumber}
                  </Link>
                  {o.site && <span className="badge badge-accent">{o.site.currentStage.label}</span>}
                </div>
                <p className="text-xs text-gray-500 mb-1">{o.product.name} ({o.product.model})</p>
                <p className="text-xs text-gray-500 mb-1" data-testid="order-po">
                  PO: <span className="font-mono">{o.poNumber ?? "-"}</span>
                  {o.poDuplicateFlag && <span className="badge badge-accent ml-1" title="Created as a duplicate PO by an admin">duplicate PO</span>}
                </p>
                {o.site ? (
                  <>
                    <p className="text-sm font-semibold text-gray-900 truncate">{o.site.companyName ?? "Unnamed site"}</p>
                    <p className="text-xs text-gray-500 mb-2 truncate">{o.site.address ?? "No site address on file"}</p>
                    <div className="data-card-row">
                      <span className="label">Engineer</span>
                      <span className="value">{o.site.assignedEngineer?.name ?? "Unassigned"}</span>
                    </div>
                    <div className="data-card-row">
                      <span className="label">Vendor</span>
                      <span className="value">{o.site.vendor?.name ?? "Internal"}</span>
                    </div>
                    <Link href={`/sites/${o.site.id}`} className="text-xs font-medium" style={{ color: "var(--theme-accent)" }}>
                      Open site progress →
                    </Link>
                  </>
                ) : (
                  <p className="text-xs text-gray-400">No site record for this order.</p>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
