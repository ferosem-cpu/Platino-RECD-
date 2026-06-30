"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/apiClient";
import { useAuth } from "@/components/AuthContext";

interface OrderRow {
  id: string;
  orderNumber: string;
  value: string;
  customer: { name: string };
  product: { name: string; model: string };
  site: { currentStage: { label: string } } | null;
}

interface Customer {
  id: string;
  name: string;
  contacts: { id: string; name: string; phone: string | null }[];
}

interface Product {
  id: string;
  name: string;
  model: string;
}

const EXHAUST_OPTIONS = [
  { value: "replace_existing_silencer", label: "Replace existing silencer with RECD" },
  { value: "add_after_existing_exhaust", label: "Add RECD after existing exhaust" },
];

const today = () => new Date().toISOString().slice(0, 10);

export default function OrdersPage() {
  const { hasPermission } = useAuth();
  const canManage = hasPermission("manage_orders");

  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [newCustomer, setNewCustomer] = useState(false);
  const [form, setForm] = useState({
    customerId: "",
    customerName: "",
    contactName: "",
    contactPhone: "",
    contactEmail: "",
    productId: "",
    quantity: "1",
    value: "",
    orderDate: today(),
    plannedExhaustHookupType: EXHAUST_OPTIONS[0].value,
  });

  function load() {
    api<OrderRow[]>("/orders").then(setOrders).catch((err) => setError(err instanceof Error ? err.message : "Failed to load orders"));
    if (canManage) {
      api<Customer[]>("/customers").then(setCustomers).catch(() => {});
      api<Product[]>("/meta/products").then(setProducts).catch(() => {});
    }
  }

  useEffect(load, [canManage]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setFormError(null);
    try {
      let customerId = form.customerId;
      if (newCustomer) {
        const created = await api<{ id: string }>("/customers", {
          method: "POST",
          body: JSON.stringify({
            name: form.customerName,
            contactName: form.contactName,
            contactPhone: form.contactPhone,
            contactEmail: form.contactEmail || undefined,
          }),
        });
        customerId = created.id;
      }
      if (!customerId) throw new Error("Please choose or create a customer");
      if (!form.productId) throw new Error("Please choose a product");

      await api("/orders", {
        method: "POST",
        body: JSON.stringify({
          customerId,
          productId: form.productId,
          quantity: parseInt(form.quantity, 10) || 1,
          value: parseFloat(form.value) || 0,
          orderDate: new Date(form.orderDate).toISOString(),
          plannedExhaustHookupType: form.plannedExhaustHookupType,
        }),
      });
      setOpen(false);
      setNewCustomer(false);
      setForm((f) => ({ ...f, customerName: "", contactName: "", contactPhone: "", contactEmail: "", value: "", quantity: "1" }));
      load();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Failed to create order");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6 max-w-5xl" data-testid="orders-page">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-semibold tracking-tight">Orders</h1>
          <p className="mt-1 text-sm text-gray-500">Sales orders and their installation progress.</p>
        </div>
        {canManage && (
          <button
            data-testid="orders-new-button"
            onClick={() => setOpen(true)}
            className="btn-primary px-4 py-2 text-sm self-start sm:self-auto"
          >
            + New order
          </button>
        )}
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {/* Desktop / tablet: table */}
      <div className="card overflow-hidden table-desktop">
        <div className="table-scroll">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="bg-gray-50 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">
                <th className="px-4 py-3">Order #</th>
                <th className="px-4 py-3">Customer</th>
                <th className="px-4 py-3">Product</th>
                <th className="px-4 py-3">Value</th>
                <th className="px-4 py-3">Current stage</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {orders.map((o) => (
                <tr key={o.id} className="hover:bg-gray-50/60">
                  <td className="px-4 py-3 font-mono text-xs font-semibold">{o.orderNumber}</td>
                  <td className="px-4 py-3">{o.customer.name}</td>
                  <td className="px-4 py-3">{o.product.name} ({o.product.model})</td>
                  <td className="px-4 py-3 whitespace-nowrap">₹{Number(o.value).toLocaleString("en-IN")}</td>
                  <td className="px-4 py-3">{o.site?.currentStage.label ?? "-"}</td>
                </tr>
              ))}
              {orders.length === 0 && (
                <tr><td colSpan={5} className="px-4 py-8 text-center text-gray-400">No orders yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Mobile: card stack */}
      <div className="cards-mobile" data-testid="orders-mobile-cards">
        {orders.length === 0 ? (
          <div className="card p-6 text-center text-sm text-gray-400">No orders yet.</div>
        ) : (
          orders.map((o) => (
            <div key={o.id} className="data-card" data-testid={`order-card-${o.orderNumber}`}>
              <div className="flex items-start justify-between gap-3 mb-2">
                <span className="font-mono text-xs font-semibold text-gray-900">{o.orderNumber}</span>
                <span className="badge badge-accent">{o.site?.currentStage.label ?? "—"}</span>
              </div>
              <p className="text-sm font-semibold text-gray-900 truncate">{o.customer.name}</p>
              <p className="text-xs text-gray-500 mb-2 truncate">{o.product.name} ({o.product.model})</p>
              <div className="data-card-row">
                <span className="label">Value</span>
                <span className="value font-semibold">₹{Number(o.value).toLocaleString("en-IN")}</span>
              </div>
            </div>
          ))
        )}
      </div>

      {open && (
        <div className="modal-backdrop" onClick={() => setOpen(false)}>
          <div className="modal-panel" onClick={(e) => e.stopPropagation()}>
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-lg font-semibold">New order</h3>
              <button onClick={() => setOpen(false)} className="text-gray-400 hover:text-gray-600">✕</button>
            </div>
            <form onSubmit={submit} className="space-y-4">
              {/* Customer */}
              <div>
                <div className="mb-1 flex items-center justify-between">
                  <label className="block text-xs font-medium text-gray-500">Customer</label>
                  <button type="button" onClick={() => setNewCustomer((v) => !v)} className="text-xs font-medium text-[var(--theme-accent)]">
                    {newCustomer ? "Choose existing" : "+ New customer"}
                  </button>
                </div>
                {newCustomer ? (
                  <div className="space-y-2 rounded-lg border border-gray-200 p-3">
                    <input required placeholder="Company name" className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" value={form.customerName} onChange={(e) => setForm({ ...form, customerName: e.target.value })} />
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      <input required placeholder="Contact name" className="rounded-lg border border-gray-300 px-3 py-2 text-sm" value={form.contactName} onChange={(e) => setForm({ ...form, contactName: e.target.value })} />
                      <input required placeholder="Contact phone (login)" className="rounded-lg border border-gray-300 px-3 py-2 text-sm" value={form.contactPhone} onChange={(e) => setForm({ ...form, contactPhone: e.target.value })} />
                    </div>
                    <input type="email" placeholder="Contact email (optional)" className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" value={form.contactEmail} onChange={(e) => setForm({ ...form, contactEmail: e.target.value })} />
                    <p className="text-[11px] text-gray-400">The phone number is what the customer uses to log in with their Order ID.</p>
                  </div>
                ) : (
                  <select required className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" value={form.customerId} onChange={(e) => setForm({ ...form, customerId: e.target.value })}>
                    <option value="">Select a customer</option>
                    {customers.map((c) => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                )}
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Product</label>
                <select required className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" value={form.productId} onChange={(e) => setForm({ ...form, productId: e.target.value })}>
                  <option value="">Select a product</option>
                  {products.map((p) => (
                    <option key={p.id} value={p.id}>{p.name} ({p.model})</option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">Quantity</label>
                  <input type="number" min={1} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" value={form.quantity} onChange={(e) => setForm({ ...form, quantity: e.target.value })} />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">Value (₹)</label>
                  <input type="number" min={0} required className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">Order date</label>
                  <input type="date" required className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" value={form.orderDate} onChange={(e) => setForm({ ...form, orderDate: e.target.value })} />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Planned exhaust hookup</label>
                <select className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" value={form.plannedExhaustHookupType} onChange={(e) => setForm({ ...form, plannedExhaustHookupType: e.target.value })}>
                  {EXHAUST_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </div>

              {formError && <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{formError}</p>}

              <div className="flex justify-end gap-3">
                <button type="button" onClick={() => setOpen(false)} className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">Cancel</button>
                <button type="submit" disabled={saving} className="btn-primary px-4 py-2 text-sm">{saving ? "Creating…" : "Create order"}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
