"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/apiClient";
import { apiErrorMessage } from "@/lib/apiError";
import { cleanMobile, mobileFieldError } from "@/lib/mobileInput";
import { AMC_TYPE_LABELS } from "@recd/shared";
import { contractStatusLabel, contractStatusPill, daysText, formatDay } from "@/lib/amcUi";
import { EditDialog, HistoryDialog, RenewDialog, type ContractTarget } from "@/components/AmcContractDialogs";

const AMC_TYPE_OPTIONS = Object.entries(AMC_TYPE_LABELS);

interface AmcOrderRow {
  id: string;
  poNo: string;
  poDate: string;
  location: string;
  item: string;
  qty: number;
  amcFrequencyPerYear: number;
  amcType: string;
  status: string;
  customer: { id: string; name: string };
  lastExpiryReminderAt: string | null;
  expiryReminderClearedAt: string | null;
  /** Explicit contract period + status, computed by the API (inclusive calendar days, "YYYY-MM-DD"). */
  startDate: string;
  endDate: string;
  datesSource: "explicit" | "legacy_po_date";
  contractStatus: "upcoming" | "renewed" | "active" | "expiring_soon" | "expired";
  daysRemaining: number;
  renewalCount: number;
  /** RECD units covered by this contract (GET /amc-orders). */
  units: { unit: { id: string; serialNo: string | null; status: string; product: { name: string; model: string } } }[];
}

/** A selectable unit in the Create AMC form (GET /recd-units?customerId=). */
interface CustomerUnit {
  id: string;
  serialNo: string | null;
  status: string;
  product: { name: string; model: string };
  site: { companyName: string | null; dgModel: string | null; dgCapacityKva: string | number | null } | null;
}

interface ContractCounts {
  upcoming: number;
  renewed: number;
  active: number;
  expiringSoon: number;
  expired: number;
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
  const [contractCounts, setContractCounts] = useState<ContractCounts | null>(null);
  const [defaultMonths, setDefaultMonths] = useState(12);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{ kind: "renew" | "edit" | "history"; order: AmcOrderRow } | null>(null);

  const [orderModalOpen, setOrderModalOpen] = useState(false);
  const [customerModalOpen, setCustomerModalOpen] = useState(false);
  const [savingOrder, setSavingOrder] = useState(false);
  const [savingCustomer, setSavingCustomer] = useState(false);
  const [orderFormError, setOrderFormError] = useState<string | null>(null);
  const [customerFormError, setCustomerFormError] = useState<string | null>(null);
  const [clearingId, setClearingId] = useState<string | null>(null);
  const [customerUnits, setCustomerUnits] = useState<CustomerUnit[]>([]);
  const [unitsLoading, setUnitsLoading] = useState(false);
  const [selectedUnitIds, setSelectedUnitIds] = useState<string[]>([]);

  const [orderForm, setOrderForm] = useState({
    poNo: "",
    poDate: today(),
    customerId: "",
    location: "",
    item: "",
    qty: "1",
    amcFrequencyPerYear: "1",
    amcType: AMC_TYPE_OPTIONS[0][0],
    startDate: "",
    endDate: "",
    durationMonths: "",
  });

  const [customerForm, setCustomerForm] = useState({
    name: "",
    address: "",
    contactName: "",
    contactPhone: "",
    contactEmail: "",
  });

  function load() {
    api<{ orders: AmcOrderRow[]; counts: Counts; contractCounts: ContractCounts; policy: { durationMonths: number } }>("/amc-orders")
      .then((data) => {
        setOrders(data.orders);
        setCounts(data.counts);
        setContractCounts(data.contractCounts);
        setDefaultMonths(data.policy.durationMonths);
        setError(null);
      })
      .catch((err) => setError(apiErrorMessage(err, "Failed to load AMC orders")))
      .finally(() => setLoading(false));
    api<Customer[]>("/customers").then(setCustomers).catch(() => {});
  }

  useEffect(load, []);

  // The units an AMC can cover are the chosen customer's RECDs that have a serial and are in service.
  useEffect(() => {
    setSelectedUnitIds([]);
    setCustomerUnits([]);
    if (!orderForm.customerId) return;
    setUnitsLoading(true);
    api<CustomerUnit[]>(`/recd-units?customerId=${encodeURIComponent(orderForm.customerId)}`)
      .then((rows) => setCustomerUnits(rows.filter((u) => u.serialNo && u.status === "active")))
      .catch((err) => setOrderFormError(apiErrorMessage(err, "Failed to load this customer's RECD units")))
      .finally(() => setUnitsLoading(false));
  }, [orderForm.customerId]);

  function toggleUnit(id: string) {
    setSelectedUnitIds((prev) => {
      const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
      // Qty follows the number of units picked (still editable afterwards).
      if (next.length) setOrderForm((f) => ({ ...f, qty: String(next.length) }));
      return next;
    });
  }

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
          amcType: orderForm.amcType,
          unitIds: selectedUnitIds,
          ...(orderForm.startDate ? { startDate: orderForm.startDate } : {}),
          ...(orderForm.endDate ? { endDate: orderForm.endDate } : orderForm.durationMonths ? { durationMonths: Number(orderForm.durationMonths) } : {}),
        }),
      });
      setOrderModalOpen(false);
      setSelectedUnitIds([]);
      setOrderForm({ poNo: "", poDate: today(), customerId: "", location: "", item: "", qty: "1", amcFrequencyPerYear: "1", amcType: AMC_TYPE_OPTIONS[0][0], startDate: "", endDate: "", durationMonths: "" });
      setNotice("AMC order created.");
      load();
    } catch (err) {
      setOrderFormError(apiErrorMessage(err, "Failed to create AMC order"));
    } finally {
      setSavingOrder(false);
    }
  }

  async function submitCustomer(e: React.FormEvent) {
    e.preventDefault();
    setCustomerFormError(null);
    const phoneError = mobileFieldError(customerForm.contactPhone);
    if (phoneError) {
      setCustomerFormError(phoneError);
      return;
    }
    setSavingCustomer(true);
    try {
      const created = await api<{ id: string }>("/customers", {
        method: "POST",
        body: JSON.stringify({
          name: customerForm.name,
          address: customerForm.address || undefined,
          contactName: customerForm.contactName,
          contactPhone: cleanMobile(customerForm.contactPhone),
          contactEmail: customerForm.contactEmail || undefined,
        }),
      });
      setCustomerModalOpen(false);
      setCustomerForm({ name: "", address: "", contactName: "", contactPhone: "", contactEmail: "" });
      setOrderForm((f) => ({ ...f, customerId: created.id }));
      load();
    } catch (err) {
      setCustomerFormError(apiErrorMessage(err, "Failed to create customer"));
    } finally {
      setSavingCustomer(false);
    }
  }

  async function clearReminder(id: string) {
    if (!confirm("Mark this AMC as acquired/renewed? This stops the expiry reminders for it.")) return;
    setClearingId(id);
    try {
      await api(`/amc-orders/${id}/clear-reminder`, { method: "PATCH" });
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to clear reminder");
    } finally {
      setClearingId(null);
    }
  }

  const target = (o: AmcOrderRow): ContractTarget => ({ id: o.id, label: `PO ${o.poNo}`, startDate: o.startDate, endDate: o.endDate });
  function dialogDone(msg: string) {
    setDialog(null);
    setNotice(msg);
    load();
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

      {error && <p role="alert" className="text-sm text-red-600" data-testid="amc-error">{error}</p>}
      {notice && <p role="status" className="text-sm text-emerald-700 bg-emerald-50 rounded-lg px-3 py-2" data-testid="amc-notice">{notice}</p>}

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

      {contractCounts && (
        <div className="flex flex-wrap gap-2 text-xs" data-testid="amc-contract-counts">
          <span className="status-pill">Upcoming {contractCounts.upcoming}</span>
          <span className="status-pill status-pill-success">Renewed {contractCounts.renewed}</span>
          <span className="status-pill status-pill-success">Active {contractCounts.active}</span>
          <span className="status-pill status-pill-warning">Expiring soon {contractCounts.expiringSoon}</span>
          <span className="status-pill status-pill-error">Expired {contractCounts.expired}</span>
        </div>
      )}

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
                <th className="px-4 py-3">RECD Serial No.</th>
                <th className="px-4 py-3">Qty</th>
                <th className="px-4 py-3">AMC Frequency per Year</th>
                <th className="px-4 py-3">AMC Type</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">AMC Period</th>
                <th className="px-4 py-3">Contract</th>
                <th className="px-4 py-3 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {orders.map((o, idx) => {
                const cleared = !!o.expiryReminderClearedAt;
                return (
                  <tr key={o.id} className="hover:bg-gray-50/60">
                    <td className="px-4 py-3">{idx + 1}</td>
                    <td className="px-4 py-3 font-mono text-xs font-semibold">{o.poNo}</td>
                    <td className="px-4 py-3">{formatDay(o.poDate)}</td>
                    <td className="px-4 py-3">{o.customer.name}</td>
                    <td className="px-4 py-3">{o.location}</td>
                    <td className="px-4 py-3">{o.item}</td>
                    <td className="px-4 py-3" data-testid="amc-serials">
                      {o.units.length === 0 ? (
                        <span className="text-xs text-gray-400">No units linked</span>
                      ) : (
                        <div className="flex flex-col gap-0.5">
                          {o.units.map(({ unit }) => (
                            <Link key={unit.id} href={`/recd-units/${unit.id}`} className="font-mono text-xs hover:underline">
                              {unit.serialNo ?? "Serial not entered"}
                            </Link>
                          ))}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3">{o.qty}</td>
                    <td className="px-4 py-3">{o.amcFrequencyPerYear}</td>
                    <td className="px-4 py-3">{AMC_TYPE_LABELS[o.amcType] ?? o.amcType}</td>
                    <td className="px-4 py-3">
                      <span className={statusPill(o.status)}>{pretty(o.status)}</span>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap" data-testid={`amc-period-${o.poNo}`}>
                      <div>{formatDay(o.startDate)} to {formatDay(o.endDate)}</div>
                      {o.datesSource === "legacy_po_date" && <span className="text-[10px] text-gray-400" title="Derived from the PO date (one year); edit the dates to make them explicit">derived from PO date</span>}
                    </td>
                    <td className="px-4 py-3" data-testid={`amc-contract-${o.poNo}`}>
                      <span className={contractStatusPill(o.contractStatus)}>{contractStatusLabel(o.contractStatus)}</span>
                      <div className="text-[10px] text-gray-500 mt-0.5">{daysText(o.contractStatus, o.daysRemaining)}</div>
                      {cleared && <span className="text-[10px] font-semibold text-emerald-600">AMC Acquired</span>}
                      {o.renewalCount > 0 && <div className="text-[10px] text-gray-500">{o.renewalCount} renewal/change{o.renewalCount === 1 ? "" : "s"}</div>}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex flex-wrap items-center justify-end gap-2">
                      <Link
                        href={`/service-reports?amcOrderId=${o.id}`}
                        data-testid={`amc-reports-link-${o.poNo}`}
                        className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
                      >
                        Service reports
                      </Link>
                      <button onClick={() => setDialog({ kind: "renew", order: o })} className="rounded-lg border border-indigo-300 px-3 py-1.5 text-xs font-medium text-indigo-700 hover:bg-indigo-50" data-testid={`amc-renew-${o.poNo}`}>Renew</button>
                      <button onClick={() => setDialog({ kind: "edit", order: o })} className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50" data-testid={`amc-edit-${o.poNo}`}>Edit</button>
                      <button onClick={() => setDialog({ kind: "history", order: o })} className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50" data-testid={`amc-history-${o.poNo}`}>History</button>
                      {!cleared && (
                        <button
                          onClick={() => clearReminder(o.id)}
                          disabled={clearingId === o.id}
                          className="rounded-lg border border-emerald-300 px-3 py-1.5 text-xs font-medium text-emerald-700 hover:bg-emerald-50 disabled:opacity-50"
                        >
                          {clearingId === o.id ? "Saving…" : "AMC Acquired"}
                        </button>
                      )}
                      </div>
                    </td>
                  </tr>
                );
              })}
              {loading && (
                <tr>
                  <td colSpan={14} className="px-4 py-12 text-center text-gray-400" data-testid="amc-loading">Loading AMC orders…</td>
                </tr>
              )}
              {!loading && orders.length === 0 && (
                <tr>
                  <td colSpan={14} className="px-4 py-12 text-center text-gray-400">
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
              {orderForm.customerId && (
                <div data-testid="amc-unit-picker">
                  <label className="block text-xs font-medium text-gray-500 mb-1">
                    RECD units covered{selectedUnitIds.length ? ` (${selectedUnitIds.length} selected)` : ""}
                  </label>
                  <div className="max-h-40 overflow-y-auto rounded-lg border border-gray-200 divide-y divide-gray-100">
                    {unitsLoading && <p className="px-3 py-3 text-xs text-gray-400">Loading units…</p>}
                    {!unitsLoading && customerUnits.length === 0 && (
                      <p className="px-3 py-3 text-xs text-gray-400">This customer has no active RECD units with a serial number.</p>
                    )}
                    {customerUnits.map((u) => (
                      <label key={u.id} className="flex items-start gap-2 px-3 py-2 text-sm cursor-pointer hover:bg-gray-50">
                        <input type="checkbox" className="mt-1" checked={selectedUnitIds.includes(u.id)} onChange={() => toggleUnit(u.id)} />
                        <span>
                          <span className="font-mono text-xs font-semibold">{u.serialNo}</span>
                          <span className="block text-xs text-gray-500">
                            {u.product.name} ({u.product.model}){u.site?.companyName ? ` · ${u.site.companyName}` : ""}
                            {u.site?.dgModel ? ` · DG ${u.site.dgModel}` : ""}
                          </span>
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              )}
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
              <div className="rounded-lg border border-gray-200 p-3 space-y-2" data-testid="amc-period-fields">
                <p className="text-xs font-semibold text-gray-600">AMC period (optional)</p>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <label className="block text-xs font-medium text-gray-500">Start date
                    <input type="date" className="field w-full mt-1" value={orderForm.startDate} onChange={(e) => setOrderForm({ ...orderForm, startDate: e.target.value })} data-testid="amc-start-date" />
                  </label>
                  <label className="block text-xs font-medium text-gray-500">End date
                    <input type="date" className="field w-full mt-1" value={orderForm.endDate} onChange={(e) => setOrderForm({ ...orderForm, endDate: e.target.value })} data-testid="amc-end-date" />
                  </label>
                  <label className="block text-xs font-medium text-gray-500">or Duration (months)
                    <input type="number" min={1} max={120} className="field w-full mt-1" placeholder={String(defaultMonths)} value={orderForm.durationMonths} onChange={(e) => setOrderForm({ ...orderForm, durationMonths: e.target.value })} disabled={!!orderForm.endDate} data-testid="amc-duration" />
                  </label>
                </div>
                <p className="text-[11px] text-gray-400">Blank start = the PO date. Blank end = start + {orderForm.durationMonths || defaultMonths} months (the day before the anniversary). Dates are inclusive.</p>
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
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">AMC Type</label>
                <select
                  required
                  className="field w-full"
                  value={orderForm.amcType}
                  onChange={(e) => setOrderForm({ ...orderForm, amcType: e.target.value })}
                >
                  {AMC_TYPE_OPTIONS.map(([key, label]) => (
                    <option key={key} value={key}>{label}</option>
                  ))}
                </select>
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

      {dialog?.kind === "renew" && <RenewDialog target={target(dialog.order)} basePath="/amc-orders" defaultMonths={defaultMonths} onClose={() => setDialog(null)} onDone={dialogDone} />}
      {dialog?.kind === "history" && <HistoryDialog target={target(dialog.order)} basePath="/amc-orders" onClose={() => setDialog(null)} />}
      {dialog?.kind === "edit" && (
        <EditDialog
          target={target(dialog.order)}
          basePath="/amc-orders"
          fields={[
            { key: "location", label: "Location", value: dialog.order.location, required: true },
            { key: "item", label: "Item", value: dialog.order.item, required: true },
            { key: "qty", label: "Qty", value: String(dialog.order.qty), type: "number", required: true },
            { key: "amcFrequencyPerYear", label: "AMC frequency per year", value: String(dialog.order.amcFrequencyPerYear), type: "number", required: true },
          ]}
          onClose={() => setDialog(null)}
          onDone={dialogDone}
        />
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
                <input required inputMode="tel" title="10-digit Indian mobile number" placeholder="Contact mobile" className="field" value={customerForm.contactPhone} onChange={(e) => setCustomerForm({ ...customerForm, contactPhone: e.target.value })} />
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
