"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { api } from "@/lib/apiClient";
import { useAuth } from "@/components/AuthContext";

interface OtherSite {
  id: string;
  address: string | null;
  companyName: string | null;
  gpsLat: string | null;
  gpsLng: string | null;
  currentStage: { label: string };
  order: { orderNumber: string };
}

interface OrderDetail {
  id: string;
  orderNumber: string;
  quantity: number;
  value: string;
  orderDate: string;
  promisedDeliveryDate: string | null;
  actualDispatchDate: string | null;
  plannedExhaustHookupType: string | null;
  customerPoNumber: string | null;
  customerPoDate: string | null;
  customer: {
    id: string;
    name: string;
    address: string | null;
    gstin: string | null;
    contacts: { name: string; phone: string | null; email: string | null }[];
  };
  product: { name: string; model: string; ratingSpec: string | null; capacityKva: string | null };
  lineItems: Array<{ id: string; quantity: number; product: { name: string; model: string } }>;
  salesEngineer: { name: string } | null;
  site: {
    id: string;
    address: string | null;
    companyName: string | null;
    gpsLat: string | null;
    gpsLng: string | null;
    currentStage: { label: string };
    assignedEngineer: { name: string } | null;
    vendor: { name: string } | null;
  } | null;
  otherCustomerSites: OtherSite[];
}

function mapsUrl(address: string | null, lat: string | null, lng: string | null): string | null {
  if (lat && lng) return `https://www.google.com/maps?q=${lat},${lng}`;
  if (address) return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
  return null;
}

export default function OrderDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { hasPermission } = useAuth();
  const canManage = hasPermission("manage_orders");
  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(() => {
    if (!id) return;
    setError(null);
    api<OrderDetail>(`/orders/${id}`).then(setOrder).catch((e) => setError(e instanceof Error ? e.message : "Failed to load order"));
  }, [id]);

  useEffect(load, [load]);

  async function deleteOrder() {
    if (!order) return;
    if (!window.confirm(`Delete order ${order.orderNumber}? This also removes its site and cannot be undone.`)) return;
    setDeleting(true);
    setError(null);
    try {
      await api(`/orders/${id}`, { method: "DELETE" });
      router.push("/orders");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete order");
      setDeleting(false);
    }
  }

  if (error && !order) return <p className="text-sm text-red-600">{error}</p>;
  if (!order) return <p className="text-sm text-gray-500">Loading...</p>;

  const contact = order.customer.contacts[0];
  const siteMap = order.site ? mapsUrl(order.site.address, order.site.gpsLat, order.site.gpsLng) : null;

  return (
    <div className="space-y-6 max-w-4xl" data-testid="order-detail-page">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Link href="/orders" className="text-xs font-medium text-gray-400 hover:text-gray-600">← Orders</Link>
          </div>
          <h1 className="text-xl sm:text-2xl font-semibold" style={{ color: "var(--text-heading)" }}>{order.orderNumber}</h1>
          <p className="text-sm text-gray-500">
            {order.customer.name} · Placed {new Date(order.orderDate).toLocaleDateString()}
            {order.salesEngineer && <> · Sales: {order.salesEngineer.name}</>}
          </p>
        </div>
        {canManage && (
          <button
            type="button"
            onClick={deleteOrder}
            disabled={deleting}
            className="rounded-lg border border-red-200 px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50 whitespace-nowrap"
          >
            {deleting ? "Deleting…" : "Delete order"}
          </button>
        )}
      </div>

      {error && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-700">{error}</div>}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <section className="card p-5 space-y-2">
          <h2 className="text-sm font-semibold">Customer</h2>
          <p className="text-sm text-gray-700">{order.customer.name}</p>
          <p className="text-sm text-gray-500 whitespace-pre-line">{order.customer.address ?? "No address on file"}</p>
          {order.customer.gstin && <p className="text-xs text-gray-400">GSTIN: {order.customer.gstin}</p>}
          {contact && (
            <p className="text-xs text-gray-500 pt-1">
              Contact: {contact.name}{contact.phone && <> · {contact.phone}</>}{contact.email && <> · {contact.email}</>}
            </p>
          )}
        </section>

        <section className="card p-5 space-y-2">
          <h2 className="text-sm font-semibold">Product</h2>
          <p className="text-sm text-gray-700">{order.product.name} ({order.product.model})</p>
          {order.product.ratingSpec && <p className="text-xs text-gray-500">{order.product.ratingSpec}</p>}
          <div className="data-card-row">
            <span className="label">Quantity</span>
            <span className="value">{order.quantity}</span>
          </div>
          <div className="data-card-row">
            <span className="label">Order value</span>
            <span className="value font-semibold">₹{Number(order.value).toLocaleString("en-IN")}</span>
          </div>
          {order.lineItems.length > 0 && (
            <div className="pt-2 border-t border-gray-100 space-y-1">
              <p className="text-xs text-gray-500">Additional units on this order</p>
              {order.lineItems.map((li) => (
                <p key={li.id} className="text-sm text-gray-700">
                  {li.product.name} ({li.product.model}) · Qty {li.quantity}
                </p>
              ))}
            </div>
          )}
        </section>

        <section className="card p-5 space-y-2">
          <h2 className="text-sm font-semibold">Dates</h2>
          <div className="data-card-row">
            <span className="label">Order date</span>
            <span className="value">{new Date(order.orderDate).toLocaleDateString()}</span>
          </div>
          <div className="data-card-row">
            <span className="label">Promised delivery</span>
            <span className="value">{order.promisedDeliveryDate ? new Date(order.promisedDeliveryDate).toLocaleDateString() : "-"}</span>
          </div>
          <div className="data-card-row">
            <span className="label">Actual dispatch</span>
            <span className="value">{order.actualDispatchDate ? new Date(order.actualDispatchDate).toLocaleDateString() : "-"}</span>
          </div>
          {order.customerPoNumber && (
            <div className="data-card-row">
              <span className="label">Customer PO</span>
              <span className="value">{order.customerPoNumber}</span>
            </div>
          )}
        </section>

        <section className="card p-5 space-y-2">
          <h2 className="text-sm font-semibold">Installation site</h2>
          {order.site ? (
            <>
              <div className="data-card-row">
                <span className="label">Site name</span>
                <span className="value">{order.site.companyName ?? "Not set"}</span>
              </div>
              <div className="data-card-row">
                <span className="label">Stage</span>
                <span className="value">{order.site.currentStage.label}</span>
              </div>
              <div className="data-card-row">
                <span className="label">Engineer</span>
                <span className="value">{order.site.assignedEngineer?.name ?? "Unassigned"}</span>
              </div>
              <div className="data-card-row">
                <span className="label">Vendor</span>
                <span className="value">{order.site.vendor?.name ?? "Internal"}</span>
              </div>
              <p className="text-sm text-gray-500 pt-1 whitespace-pre-line">{order.site.address ?? "No site address on file"}</p>
              <div className="flex flex-wrap gap-3 pt-1">
                <Link href={`/sites/${order.site.id}`} className="btn-primary px-3 py-1.5 text-xs">Open site progress</Link>
                {siteMap && (
                  <a href={siteMap} target="_blank" rel="noreferrer" className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50">
                    📍 View on Google Maps
                  </a>
                )}
              </div>
            </>
          ) : (
            <p className="text-sm text-gray-400">No site record.</p>
          )}
        </section>
      </div>

      <section>
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-medium text-gray-600">
            {order.otherCustomerSites.length > 0
              ? `Other sites for ${order.customer.name} (${order.otherCustomerSites.length})`
              : `Sites for ${order.customer.name}`}
          </h2>
          {canManage && (
            <Link
              href={`/orders?customer=${order.customer.id}`}
              className="text-xs font-medium text-[var(--theme-accent)] whitespace-nowrap"
            >
              + Add site
            </Link>
          )}
        </div>
        <p className="mb-3 text-xs text-gray-400">
          A customer can have multiple installation sites - each one gets its own address/location and progress tracking.
        </p>
        {order.otherCustomerSites.length === 0 && (
          <p className="text-sm text-gray-400">No other sites for this customer yet.</p>
        )}
        {order.otherCustomerSites.length > 0 && (
          <div className="cards-mobile sm:grid sm:grid-cols-2 sm:gap-3 sm:space-y-0">
            {order.otherCustomerSites.map((s) => {
              const otherMap = mapsUrl(s.address, s.gpsLat, s.gpsLng);
              return (
                <div key={s.id} className="data-card">
                  <div className="flex items-start justify-between gap-3 mb-2">
                    <Link href={`/sites/${s.id}`} className="font-mono text-xs font-semibold hover:underline" style={{ color: "var(--theme-primary)" }}>
                      {s.order.orderNumber}
                    </Link>
                    <span className="badge badge-accent">{s.currentStage.label}</span>
                  </div>
                  <p className="text-sm font-semibold text-gray-900 truncate">{s.companyName ?? "Unnamed site"}</p>
                  <p className="text-xs text-gray-500 mb-2 truncate">{s.address ?? "No address on file"}</p>
                  {otherMap && (
                    <a href={otherMap} target="_blank" rel="noreferrer" className="text-xs font-medium" style={{ color: "var(--theme-accent)" }}>
                      📍 View on Google Maps
                    </a>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
