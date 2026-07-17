"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/apiClient";

interface AmcOrderRow {
  id: string;
  poNo: string;
  poDate: string;
  location: string;
  item: string;
  qty: number;
  amcFrequencyPerYear: number;
  status: string;
  customer: { id: string; name: string };
}

interface Counts {
  total: number;
  completed: number;
  inProgress: number;
  yetToStart: number;
}

interface Customer {
  id: string;
  name: string;
}

const today = () => new Date().toISOString().slice(0, 10);

function statusPill(status: string) {
  if (status === "completed") return "status-pill status-pill-success";
  if (status === "in_progress") return "status-pill status-pill-warning";
  return "status-pill";
}

function pretty(s: string) {
  return s.replaceAll("_", " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export default function AmcOrdersPage() {
  const [orders, setOrders] = useState<AmcOrderRow[]>([]);
  const [counts, setCounts] = useState<Counts | null>(null);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [orderModalOpen, setOrderModalOpen] = useState(false);
  const [customerModalOpen, setCustomerModalOpen] = useState(false);
  const [savingOrder, setSavingOrder] = useState(false);
  const [savingCustomer, setSavingCustomer] = useState(false);
  const [orderFormError, setOrderFormError] = useState<string | null>(null);
  const [customerFormError, setCustomerFormError] = useState<string | null>(null);

  const [orderForm, setOrderForm] = useState({
    poNo: "",
    poDate: today(),
    customerId: "",
    location: "",
    item: "",
    qty: "1",
    amcFrequencyPerYear: "1",
  });

  const [customerForm, setCustomerForm] = useState({
    name: "",
    address: "",
    contactName: "",
    contactPhone: "",
    contactEmail: "",
  });

  function load() {
    api<{ orders: AmcOrderRow[]; counts: Counts }>("/amc-orders")
      .then((data) => {
        setOrders(data.orders);
        setCounts(data.counts);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load AMC orders"));
    api<Customer[]>("/customers").then(setCustomers).catch(() => {});
  }

  useEffect(load, []);

  async function submitOrder(e: React.FormEvent) {
    e.preventDefault();
    setSavingOrder(true);
    setOrderFormError(null);
    try {
      if (!orderForm.customerId) throw new Error("Please choose a customer");
      await api("/amc-orders", {
        method: "POST",
        body: JSON.stringify({
          poNo: orderForm.poNo,
          poDate: new Date(orderForm.poDate).toISOString(),
          customerId: orderForm.customerId,
          location: orderForm.location,
          item: orderForm.item,
          qty: parseInt(orderForm.qty, 10) || 1,
          amcFrequencyPerYear: parseInt(orderForm.amcFrequencyPerYear, 10) || 1,
        }),
      });
      setOrderModalOpen(false);
      setOrderForm({ poNo: "", poDate: today(), customerId: "", location: "", item: "", qty: "1", amcFrequencyPerYear: "1" });
      load();
    } catch (err) {
      setOrderFormError(err instanceof Error ? err.message : "Failed to create AMC order");
    } finally {
      setSavingOrder(false);
    }
  }

  async function submitCustomer(e: React.FormEvent) {
    e.preventDefault();
    setSavingCustomer(true);
    setCustomerFormError(null);
    try {
      const created = await api<{ id: string }>("/customers", {
        method: "POST",
        body: JSON.stringify({
          name: customerForm.name,
          address: customerForm.address || undefined,
          contactName: customerForm.contactName,
          contactPhone: customerForm.contactPhone,
          contactEmail: customerForm.contactEmail || undefined,
        }),
      });
      setCustomerModalOpen(false);
      setCustomerForm({ name: "", address: "", contactName: "", contactPhone: "", contactEmail: "" });
      setOrderForm((f) => ({ ...f, customerId: created.id }));
      load();
    } catch (err) {
      setCustomerFormError(err instanceof Error ? err.message : "Failed to create customer");
    } finally {
      setSavingCustomer(false);
    }
  }

  const statTiles = [
    {
      label: "Total AMC order",
      value: counts?.total ?? 0,
      bg: "#E0E7FF",
      fg: "#4338CA",
      icon: "M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 002.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 00-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 00.75-.75 2.25 2.25 0 00-.1-.664m-5.8 0A2.251 2.251 0 0113.5 2.25H15a2.25 2.25 0 012.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25z",
    },
    {
      label: "Total AMC completed",
      value: counts?.completed ?? 0,
      bg: "#DCFCE7",
      fg: "#16A34A",
      icon: "M4.5 12.75l6 6 9-13.5",
    },
    {
      label: "Total AMC in progress",
      value: counts?.inProgress ?? 0,
      bg: "#FFEDD5",
      fg: "#EA580C",
      icon: "M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z",
    },
    {
      label: "Total AMC yet to start",
      value: counts?.yetToStart ?? 0,
      bg: "#FEE2E2",
      fg: "#DC2626",
      icon: "M12 9v3.75m0 3.75h.008v.008H12v-.008zM21 12a9 9 0 11-18 0 9 9 0 0118 0z",
    },
  ];

  return (
    <div className="space-y-6 max-w-6xl" data-testid="amc-orders-page">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-semibold tracking-tight" style={{ color: "var(--text-heading)" }}>AMC Order</h1>
          <p className="mt-1 text-sm text-gray-500">Track and manage AMC orders across all sites.</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => setOrderModalOpen(true)} className="btn-primary px-4 py-2 text-sm" data-testid="amc-new-order-button">
            + Create New Order
          </button>
          <button
            onClick={() => setCustomerModalOpen(true)}
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium hover:bg-gray-50"
            data-testid="amc-new-customer-button"
          >
            + Create New Customer
          </button>
        </div>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {statTiles.map((t) => (
          <div key={t.label} className="card p-5">
            <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-full" style={{ backgroundColor: t.bg }}>
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke={t.fg} strokeWidth={1.75}>
                <path strokeLinecap="round" strokeLinejoin="round" d={t.icon} />
              </svg>
            </div>
            <div className="text-2xl font-bold">{t.value}</div>
            <div className="text-xs text-gray-500 mt-0.5">{t.label}</div>
          </div>
        ))}
      </div>

      <div className="card overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-100">
          <h2 className="text-sm font-semibold">AMC Order List</h2>
        </div>
        <div className="table-scroll">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="bg-gray-50 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">
                <th className="px-4 py-3">S.No</th>
                <th className="px-4 py-3">PO No</th>
                <th className="px-4 py-3">PO Date</th>
                <th className="px-4 py-3">Customer Name</th>
                <th className="px-4 py-3">Location</th>
                <th className="px-4 py-3">Item</th>
                <th className="px-4 py-3">Qty</th>
                <th className="px-4 py-3">AMC Frequency per Year</th>
                <th className="px-4 py-3">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {orders.map((o, idx) => (
                <tr key={o.id} className="hover:bg-gray-50/60">
                  <td className="px-4 py-3">{idx + 1}</td>
                  <td className="px-4 py-3 font-mono text-xs font-semibold">{o.poNo}</td>
                  <td className="px-4 py-3">{new Date(o.poDate).toLocaleDateString()}</td>
                  <td className="px-4 py-3">{o.customer.name}</td>
                  <td className="px-4 py-3">{o.location}</td>
                  <td className="px-4 py-3">{o.item}</td>
                  <td className="px-4 py-3">{o.qty}</td>
                  <td className="px-4 py-3">{o.amcFrequencyPerYear}</td>
                  <td className="px-4 py-3">
                    <span className={statusPill(o.status)}>{pretty(o.status)}</span>
                  </td>
                </tr>
              ))}
              {orders.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-4 py-12 text-center text-gray-400">
                    No AMC orders found.
                    <br />
                    <span className="text-xs">Create a new AMC order to get started.</span>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {orderModalOpen && (
        <div className="modal-backdrop" onClick={() => setOrderModalOpen(false)}>
          <div className="modal-panel" onClick={(e) => e.stopPropagation()}>
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-lg font-semibold">Create New AMC Order</h3>
              <button onClick={() => setOrderModalOpen(false)} className="text-gray-400 hover:text-gray-600">✕</button>
            </div>
            <form onSubmit={submitOrder} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Customer</label>
                <select
                  required
                  className="field w-full"
                  value={orderForm.customerId}
                  onChange={(e) => setOrderForm({ ...orderForm, customerId: e.target.value })}
                >
                  <option value="">Select a customer</option>
                  {customers.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">PO No</label>
                  <input required className="field w-full" value={orderForm.poNo} onChange={(e) => setOrderForm({ ...orderForm, poNo: e.target.value })} />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">PO Date</label>
                  <input required type="date" className="field w-full" value={orderForm.poDate} onChange={(e) => setOrderForm({ ...orderForm, poDate: e.target.value })} />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Location</label>
                <input required className="field w-full" value={orderForm.location} onChange={(e) => setOrderForm({ ...orderForm, location: e.target.value })} />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Item</label>
                <input required className="field w-full" value={orderForm.item} onChange={(e) => setOrderForm({ ...orderForm, item: e.target.value })} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">Qty</label>
                  <input required type="number" min={1} className="field w-full" value={orderForm.qty} onChange={(e) => setOrderForm({ ...orderForm, qty: e.target.value })} />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">AMC Frequency / Year</label>
                  <input required type="number" min={1} className="field w-full" value={orderForm.amcFrequencyPerYear} onChange={(e) => setOrderForm({ ...orderForm, amcFrequencyPerYear: e.target.value })} />
                </div>
              </div>

              {orderFormError && <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{orderFormError}</p>}

              <div className="flex justify-end gap-3">
                <button type="button" onClick={() => setOrderModalOpen(false)} className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">Cancel</button>
                <button type="submit" disabled={savingOrder} className="btn-primary px-4 py-2 text-sm">{savingOrder ? "Creating…" : "Create order"}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {customerModalOpen && (
        <div className="modal-backdrop" onClick={() => setCustomerModalOpen(false)}>
          <div className="modal-panel" onClick={(e) => e.stopPropagation()}>
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-lg font-semibold">Create New Customer</h3>
              <button onClick={() => setCustomerModalOpen(false)} className="text-gray-400 hover:text-gray-600">✕</button>
            </div>
            <form onSubmit={submitCustomer} className="space-y-3">
              <input required placeholder="Company name" className="field w-full" value={customerForm.name} onChange={(e) => setCustomerForm({ ...customerForm, name: e.target.value })} />
              <input placeholder="Address" className="field w-full" value={customerForm.address} onChange={(e) => setCustomerForm({ ...customerForm, address: e.target.value })} />
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <input required placeholder="Contact name" className="field" value={customerForm.contactName} onChange={(e) => setCustomerForm({ ...customerForm, contactName: e.target.value })} />
                <input required placeholder="Contact phone" className="field" value={customerForm.contactPhone} onChange={(e) => setCustomerForm({ ...customerForm, contactPhone: e.target.value })} />
              </div>
              <input type="email" placeholder="Contact email (optional)" className="field w-full" value={customerForm.contactEmail} onChange={(e) => setCustomerForm({ ...customerForm, contactEmail: e.target.value })} />

              {customerFormError && <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{customerFormError}</p>}

              <div className="flex justify-end gap-3 pt-1">
                <button type="button" onClick={() => setCustomerModalOpen(false)} className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">Cancel</button>
                <button type="submit" disabled={savingCustomer} className="btn-primary px-4 py-2 text-sm">{savingCustomer ? "Creating…" : "Create customer"}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
