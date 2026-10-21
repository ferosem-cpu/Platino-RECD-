"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { api } from "@/lib/apiClient";
import { apiErrorMessage, withoutFieldPrefix } from "@/lib/apiError";
import { cleanMobile, mobileFieldError } from "@/lib/mobileInput";
import { canOverrideDuplicatePo } from "@recd/shared";
import { useAuth } from "@/components/AuthContext";
import { DataTable } from "@/components/DataTable";
import { formatOptionalRupees } from "@/lib/format";

interface OrderRow {
  id: string;
  orderNumber: string;
  value: string | null;
  customer: { name: string };
  product: { name: string; model: string };
  lineItems: { product: { name: string; model: string } }[];
  site: { companyName: string | null; currentStage: { label: string } } | null;
  poNumber: string | null;
  poDuplicateFlag: boolean;
  units: { id: string; serialNo: string | null }[];
}

/** All RECDs on this order - the base product plus any extra units added as line items
 * (the "add another RECD unit -> same order" path) - see the identical Sites-page fix. */
function allProducts(o: OrderRow): { name: string; model: string }[] {
  return [o.product, ...o.lineItems.map((li) => li.product)];
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
  return (
    <Suspense fallback={null}>
      <OrdersPageInner />
    </Suspense>
  );
}

function OrdersPageInner() {
  const { hasPermission, user } = useAuth();
  // Same role list the API enforces; hiding the box is a convenience only - POST /orders still decides.
  const canOverridePo = canOverrideDuplicatePo(user?.role.key);
  const canManage = hasPermission("manage_orders");
  const searchParams = useSearchParams();
  const addSiteForCustomerId = searchParams.get("customer");

  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [newCustomer, setNewCustomer] = useState(false);
  const [newProduct, setNewProduct] = useState(false);
  const [form, setForm] = useState({
    customerId: "",
    customerName: "",
    customerAddress: "",
    contactName: "",
    contactPhone: "",
    contactEmail: "",
    productId: "",
    productName: "",
    productModel: "",
    productRatingSpec: "",
    quantity: "1",
    value: "",
    orderDate: today(),
    plannedExhaustHookupType: EXHAUST_OPTIONS[0].value,
    poNumber: "",
    poDate: "",
    allowDuplicatePo: false,
  });
  // One RECD serial per unit - the array is resized to `quantity` at render/submit time.
  const [serials, setSerials] = useState<string[]>([""]);
  const qty = Math.max(1, Math.min(50, parseInt(form.quantity, 10) || 1));
  const serialInputs = Array.from({ length: qty }, (_, i) => serials[i] ?? "");
  function setSerialAt(i: number, v: string) {
    setSerials((prev) => {
      const next = Array.from({ length: qty }, (_, k) => prev[k] ?? "");
      next[i] = v;
      return next;
    });
  }

  function load() {
    api<OrderRow[]>("/orders").then(setOrders).catch((err) => setError(err instanceof Error ? err.message : "Failed to load orders"));
    if (canManage) {
      api<Customer[]>("/customers").then(setCustomers).catch(() => {});
      api<Product[]>("/meta/products").then(setProducts).catch(() => {});
    }
  }

  useEffect(load, [canManage]);

  // Arriving from an order/customer's "Add site" link - prefill and open the modal
  // instead of making the user re-pick the customer from the dropdown.
  useEffect(() => {
    if (addSiteForCustomerId && customers.some((c) => c.id === addSiteForCustomerId)) {
      setForm((f) => ({ ...f, customerId: addSiteForCustomerId }));
      setOpen(true);
    }
  }, [addSiteForCustomerId, customers]);

  const addSiteForCustomer = addSiteForCustomerId ? customers.find((c) => c.id === addSiteForCustomerId) : undefined;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setFormError(null);
    try {
      let customerId = form.customerId;
      if (newCustomer) {
        const phoneError = mobileFieldError(form.contactPhone);
        if (phoneError) throw new Error(phoneError);
        const created = await api<{ id: string }>("/customers", {
          method: "POST",
          body: JSON.stringify({
            name: form.customerName,
            address: form.customerAddress || undefined,
            contactName: form.contactName,
            contactPhone: cleanMobile(form.contactPhone),
            contactEmail: form.contactEmail || undefined,
          }),
        });
        customerId = created.id;
      }
      if (!customerId) throw new Error("Please choose or create a customer");

      let productId = form.productId;
      if (newProduct) {
        const created = await api<{ id: string }>("/products", {
          method: "POST",
          body: JSON.stringify({
            name: form.productName,
            model: form.productModel,
            ratingSpec: form.productRatingSpec || undefined,
          }),
        });
        productId = created.id;
      }
      if (!productId) throw new Error("Please choose or create a product");
      if (serialInputs.some((v) => !v.trim())) throw new Error(`Enter the RECD serial number for each of the ${qty} unit(s)`);
      const upper = serialInputs.map((v) => v.trim().toUpperCase());
      if (new Set(upper).size !== upper.length) throw new Error("The same serial number is entered twice");

      await api("/orders", {
        method: "POST",
        body: JSON.stringify({
          customerId,
          productId,
          quantity: qty,
          value: parseFloat(form.value) || 0,
          poNumber: form.poNumber.trim(),
          poDate: form.poDate ? new Date(form.poDate).toISOString() : undefined,
          allowDuplicatePo: (canOverridePo && form.allowDuplicatePo) || undefined,
          recdSerials: serialInputs.map((v) => v.trim()),
          orderDate: new Date(form.orderDate).toISOString(),
          plannedExhaustHookupType: form.plannedExhaustHookupType,
        }),
      });
      setOpen(false);
      setNewCustomer(false);
      setNewProduct(false);
      setForm((f) => ({
        ...f,
        customerName: "",
        customerAddress: "",
        contactName: "",
        contactPhone: "",
        contactEmail: "",
        productName: "",
        productModel: "",
        productRatingSpec: "",
        value: "",
        quantity: "1",
        poNumber: "",
        poDate: "",
        allowDuplicatePo: false,
      }));
      setSerials([""]);
      load();
    } catch (err) {
      setFormError(withoutFieldPrefix(apiErrorMessage(err, "Failed to create order"), "recdSerials"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6 max-w-5xl" data-testid="orders-page">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 print:hidden">
        <div>
          <h1 className="text-xl sm:text-2xl font-semibold tracking-tight" style={{ color: "var(--text-heading)" }}>Orders</h1>
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

      {error && <p className="text-sm text-red-600 print:hidden">{error}</p>}

      <DataTable
        storageKey="orders"
        title="Orders"
        rows={orders}
        rowKey={(o) => o.id}
        emptyMessage="No orders yet."
        columns={[
          {
            key: "orderNumber",
            label: "Order #",
            accessor: (o) => o.orderNumber,
            filterType: "text",
            alwaysVisible: true,
            render: (o) => (
              <Link href={`/orders/${o.id}`} className="font-mono text-xs font-semibold hover:underline" style={{ color: "var(--theme-primary)" }}>
                {o.orderNumber}
              </Link>
            ),
          },
          {
            key: "po",
            label: "PO #",
            accessor: (o) => o.poNumber ?? "",
            filterType: "text",
            render: (o) => (
              <span className="whitespace-nowrap">
                {o.poNumber ?? "—"}
                {o.poDuplicateFlag && <span className="badge badge-accent ml-1" title="Created as a duplicate PO by an admin">dup</span>}
              </span>
            ),
          },
          {
            key: "serials",
            label: "RECD serial no.",
            accessorList: (o) => o.units.map((u) => u.serialNo ?? "pending"),
            render: (o) => (
              <span className="font-mono text-xs">
                {o.units.length === 0 ? "—" : o.units.map((u, i) => (
                  <span key={u.id} className={u.serialNo ? "" : "text-amber-600"}>
                    {i > 0 && ", "}{u.serialNo ?? "pending"}
                  </span>
                ))}
              </span>
            ),
          },
          { key: "siteName", label: "Site name", accessor: (o) => o.site?.companyName ?? "", render: (o) => o.site?.companyName ?? "Not set", filterType: "text" },
          { key: "customer", label: "Customer", accessor: (o) => o.customer.name },
          {
            key: "product",
            label: "Product",
            accessorList: (o) => allProducts(o).map((p) => `${p.name} (${p.model})`),
            render: (o) => (
              <>
                {allProducts(o).map((p, i) => (
                  <span key={i}>
                    {i > 0 && ", "}
                    {p.name} ({p.model})
                  </span>
                ))}
              </>
            ),
          },
          {
            key: "value",
            label: "Value",
            accessor: (o) => Number(o.value),
            filterType: "text",
            render: (o) => <span className="whitespace-nowrap">{formatOptionalRupees(o.value)}</span>,
          },
          { key: "stage", label: "Current stage", accessor: (o) => o.site?.currentStage.label ?? "" },
        ]}
      >
        {(filteredOrders) => (
          <div className="cards-mobile" data-testid="orders-mobile-cards">
            {filteredOrders.length === 0 ? (
              <div className="card p-6 text-center text-sm text-gray-400">
                {orders.length === 0 ? "No orders yet." : "No rows match the current filters."}
              </div>
            ) : (
              filteredOrders.map((o) => (
                <Link key={o.id} href={`/orders/${o.id}`} className="data-card block" data-testid={`order-card-${o.orderNumber}`}>
                  <div className="flex items-start justify-between gap-3 mb-2">
                    <span className="font-mono text-xs font-semibold text-gray-900">{o.orderNumber}</span>
                    <span className="badge badge-accent">{o.site?.currentStage.label ?? "—"}</span>
                  </div>
                  <p className="text-sm font-semibold text-gray-900 truncate">{o.site?.companyName ?? "Not set"}</p>
                  <p className="text-xs text-gray-500 truncate">{o.customer.name}</p>
                  <p className="text-xs text-gray-500 mb-2 truncate">{allProducts(o).map((p) => `${p.name} (${p.model})`).join(", ")}</p>
                  <div className="data-card-row">
                    <span className="label">Value</span>
                    <span className="value font-semibold">{formatOptionalRupees(o.value)}</span>
                  </div>
                </Link>
              ))
            )}
          </div>
        )}
      </DataTable>

      {open && (
        <div className="modal-backdrop" onClick={() => setOpen(false)}>
          <div className="modal-panel" onClick={(e) => e.stopPropagation()}>
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-lg font-semibold">{addSiteForCustomer ? `New site for ${addSiteForCustomer.name}` : "New order"}</h3>
              <button onClick={() => setOpen(false)} className="text-gray-400 hover:text-gray-600">✕</button>
            </div>
            <form onSubmit={submit} className="space-y-4">
              {/* Customer */}
              {addSiteForCustomer ? (
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">Customer</label>
                  <p className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-700">{addSiteForCustomer.name}</p>
                </div>
              ) : (
              <div>
                <div className="mb-1 flex items-center justify-between">
                  <label className="block text-xs font-medium text-gray-500">Customer</label>
                  <button type="button" onClick={() => setNewCustomer((v) => !v)} className="text-xs font-medium text-[var(--theme-accent)]">
                    {newCustomer ? "Choose existing" : "+ New customer"}
                  </button>
                </div>
                {newCustomer ? (
                  <div className="space-y-2 rounded-lg border border-gray-200 p-3">
                    <input required placeholder="Company name" className="field w-full" value={form.customerName} onChange={(e) => setForm({ ...form, customerName: e.target.value })} />
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      <input required placeholder="Contact name" className="field" value={form.contactName} onChange={(e) => setForm({ ...form, contactName: e.target.value })} />
                      <input required inputMode="tel" title="10-digit Indian mobile number" placeholder="Contact mobile (login)" className="field" value={form.contactPhone} onChange={(e) => setForm({ ...form, contactPhone: e.target.value })} />
                    </div>
                    <input type="email" placeholder="Contact email (optional)" className="field w-full" value={form.contactEmail} onChange={(e) => setForm({ ...form, contactEmail: e.target.value })} />
                    <textarea placeholder="Address (optional)" rows={2} className="field w-full" value={form.customerAddress} onChange={(e) => setForm({ ...form, customerAddress: e.target.value })} />
                    <p className="text-[11px] text-gray-400">The phone number is what the customer uses to log in with their Order ID.</p>
                  </div>
                ) : (
                  <select required className="field w-full" value={form.customerId} onChange={(e) => setForm({ ...form, customerId: e.target.value })}>
                    <option value="">Select a customer</option>
                    {customers.map((c) => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                )}
              </div>
              )}

              <div>
                <div className="mb-1 flex items-center justify-between">
                  <label className="block text-xs font-medium text-gray-500">Product</label>
                  <button type="button" onClick={() => setNewProduct((v) => !v)} className="text-xs font-medium text-[var(--theme-accent)]">
                    {newProduct ? "Choose existing" : "+ New product"}
                  </button>
                </div>
                {newProduct ? (
                  <div className="space-y-2 rounded-lg border border-gray-200 p-3">
                    <input required placeholder="Product name" className="field w-full" value={form.productName} onChange={(e) => setForm({ ...form, productName: e.target.value })} />
                    <input required placeholder="Model (unique)" className="field w-full" value={form.productModel} onChange={(e) => setForm({ ...form, productModel: e.target.value })} />
                    <input placeholder="Rating spec (optional)" className="field w-full" value={form.productRatingSpec} onChange={(e) => setForm({ ...form, productRatingSpec: e.target.value })} />
                  </div>
                ) : (
                  <select required className="field w-full" value={form.productId} onChange={(e) => setForm({ ...form, productId: e.target.value })}>
                    <option value="">Select a product</option>
                    {products.map((p) => (
                      <option key={p.id} value={p.id}>{p.name} ({p.model})</option>
                    ))}
                  </select>
                )}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">Quantity</label>
                  <input type="number" min={1} className="field w-full" value={form.quantity} onChange={(e) => setForm({ ...form, quantity: e.target.value })} />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">Value (₹)</label>
                  <input type="number" min={0} required className="field w-full" value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">Order date</label>
                  <input type="date" required className="field w-full" value={form.orderDate} onChange={(e) => setForm({ ...form, orderDate: e.target.value })} />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">Customer PO number</label>
                  <input required maxLength={60} className="field w-full" value={form.poNumber} onChange={(e) => setForm({ ...form, poNumber: e.target.value })} data-testid="order-po-number" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">PO date (optional)</label>
                  <input type="date" className="field w-full" value={form.poDate} onChange={(e) => setForm({ ...form, poDate: e.target.value })} />
                </div>
              </div>
              {canOverridePo && (
              <label className="flex items-center gap-2 text-xs text-gray-500">
                <input type="checkbox" data-testid="order-allow-duplicate-po" checked={form.allowDuplicatePo} onChange={(e) => setForm({ ...form, allowDuplicatePo: e.target.checked })} />
                Allow a duplicate PO for this customer (the order is flagged)
              </label>
              )}

              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">RECD serial number{qty > 1 ? "s (one per unit)" : ""}</label>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {serialInputs.map((v, i) => (
                    <input
                      key={i}
                      required
                      minLength={3}
                      maxLength={40}
                      placeholder={qty > 1 ? `Unit ${i + 1} serial` : "Serial number"}
                      className="field w-full font-mono"
                      value={v}
                      onChange={(e) => setSerialAt(i, e.target.value)}
                      data-testid={`order-serial-${i}`}
                    />
                  ))}
                </div>
                <p className="mt-1 text-[11px] text-gray-400">Each physical RECD has its own unique serial number - it can never be reused.</p>
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Planned exhaust hookup</label>
                <select className="field w-full" value={form.plannedExhaustHookupType} onChange={(e) => setForm({ ...form, plannedExhaustHookupType: e.target.value })}>
                  {EXHAUST_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </div>

              {formError && <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{formError}</p>}

              <div className="flex justify-end gap-3">
                <button type="button" onClick={() => setOpen(false)} className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors">Cancel</button>
                <button type="submit" disabled={saving} className="btn-primary px-4 py-2 text-sm">{saving ? "Creating…" : "Create order"}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
