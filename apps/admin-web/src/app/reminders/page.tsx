"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { api } from "@/lib/apiClient";
import { friendlyApiMessage } from "@/lib/apiError";
import { useAuth } from "@/components/AuthContext";
import { attemptSuffix, escalationInfo, reminderLabel } from "@/lib/reminderUi";

interface ReminderEvent { id: string; type: string; level: number; channel: string | null; recipient: string | null; at: string; attempt?: number | null }
interface Row {
  key: string;
  activityType: "ticket" | "amc_visit";
  activityId: string;
  activityRef: string;
  customerName: string;
  siteName: string | null;
  serialNo: string | null;
  serialMissing: boolean;
  dueDate: string | null;
  state: "no_due_date" | "pending" | "due_soon" | "overdue";
  regionId: string | null;
  regionName: string | null;
  managers: Array<{ id: string; name: string; role: string }>;
  reminder: null | {
    id: string; status: string; statusReason: string | null; attempts: number; sentAt: string | null;
    acknowledgedAt: string | null; acknowledgedBy: string | null; escalationLevel: number; lastEscalatedAt: string | null; escalationAttempts?: number | null; events: ReminderEvent[];
  };
  links: { activity: string | null; unit: string | null };
}
interface Overview {
  policy: { reminderLeadDays: number | null; reminderEscalationHours: number | null; remindersEnabled: boolean };
  counts: { pending: number; dueSoon: number; overdue: number; noDueDate: number; noRecipient: number };
  canAcknowledge: boolean;
  rows: Row[];
}
interface RegionOption { id: string; name: string; managers: Array<{ id: string; name: string }> }

const STATE_LABEL: Record<Row["state"], string> = { no_due_date: "No due date", pending: "Pending", due_soon: "Due soon", overdue: "Overdue" };
const STATE_PILL: Record<Row["state"], string> = { no_due_date: "status-pill", pending: "status-pill", due_soon: "status-pill status-pill-warning", overdue: "status-pill status-pill-error" };

const EVENT_TEXT: Record<string, string> = {
  created: "Reminder created", sent: "E-mail delivered", in_app_recorded: "In-app record written (not a delivery)", delivery_failed: "Delivery failed", no_recipient: "No recipient found", acknowledged: "Acknowledged",
  escalated: "Escalated", escalation_no_recipient: "Escalation: nobody to send to", due_date_changed: "Due date changed", closed: "Closed (activity finished)",
};

function Dashboard() {
  const params = useSearchParams();
  const focus = params.get("focus");
  const { hasPermission } = useAuth();
  const [data, setData] = useState<Overview | null>(null);
  const [regions, setRegions] = useState<RegionOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [filters, setFilters] = useState({ state: "all", regionId: "", managerId: "", reminder: "", from: "", to: "" });
  const [dueInput, setDueInput] = useState<Record<string, string>>({});

  const load = useCallback(() => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(filters)) if (v && !(k === "state" && v === "all")) q.set(k, v);
    setError(null);
    api<Overview>(`/reminders${q.toString() ? `?${q}` : ""}`)
      .then(setData)
      .catch((err) => {
        setData(null);
        setError(friendlyApiMessage(err, "Unable to load reminders. Please try again."));
      });
  }, [filters]);

  useEffect(load, [load]);
  useEffect(() => {
    api<RegionOption[]>("/regions").then(setRegions).catch(() => setRegions([]));
  }, []);

  async function acknowledge(row: Row) {
    if (!row.reminder) return;
    setBusy(row.key);
    setNotice(null);
    try {
      await api(`/reminders/${row.reminder.id}/acknowledge`, { method: "POST" });
      setNotice(`Acknowledged ${row.activityRef}.`);
      load();
    } catch (err) {
      setError(friendlyApiMessage(err, "Could not acknowledge this reminder. Please try again."));
      load();
    } finally {
      setBusy(null);
    }
  }

  async function saveDueDate(row: Row) {
    const value = dueInput[row.key];
    if (!value) return;
    setBusy(row.key);
    setError(null);
    try {
      await api(`/reminders/tickets/${row.activityId}/due-date`, { method: "PUT", body: JSON.stringify({ dueDate: value }) });
      setNotice(`Due date saved for ${row.activityRef}.`);
      load();
    } catch (err) {
      setError(friendlyApiMessage(err, "Could not save the due date. Please try again."));
    } finally {
      setBusy(null);
    }
  }

  const managers = Array.from(new Map(regions.flatMap((r) => r.managers).map((m) => [m.id, m])).values());
  const canAck = data?.canAcknowledge && hasPermission("manage_complaints");

  return (
    <div className="space-y-6 max-w-6xl" data-testid="reminders-page">
      <div>
        <h1 className="text-xl sm:text-2xl font-semibold tracking-tight" style={{ color: "var(--text-heading)" }}>Service reminders</h1>
        <p className="mt-1 text-sm text-gray-500">Pending, due-soon and overdue service activities that have a due date, with the reminders sent for them. Only activities in your regions are shown.</p>
      </div>

      {data && !data.policy.remindersEnabled && (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800" data-testid="reminders-off">
          Reminders are switched OFF: nothing is sent or escalated until the reminder policy is filled in under Settings. You can still see what is pending or overdue.
        </p>
      )}
      {data && data.policy.remindersEnabled && (
        <p className="text-xs text-gray-500">
          Policy: reminders start {data.policy.reminderLeadDays} day(s) before the due date; {data.policy.reminderEscalationHours ? `an unacknowledged reminder escalates after ${data.policy.reminderEscalationHours} h` : "escalation is off"}.
        </p>
      )}
      {error && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}
      {notice && <p role="status" className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{notice}</p>}

      {data && (
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3" data-testid="reminder-counts">
          {([["Pending", data.counts.pending, "pending"], ["Due soon", data.counts.dueSoon, "due_soon"], ["Overdue", data.counts.overdue, "overdue"], ["No due date", data.counts.noDueDate, "no_due_date"], ["No recipient", data.counts.noRecipient, ""]] as const).map(([label, n, state]) => (
            <button
              key={label}
              type="button"
              onClick={() => state && setFilters({ ...filters, state })}
              className="rounded-xl border border-gray-200 bg-white p-3 text-left hover:bg-gray-50"
            >
              <div className="text-2xl font-semibold">{n}</div>
              <div className="text-xs text-gray-500">{label}</div>
            </button>
          ))}
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-6 gap-3 rounded-xl border border-gray-200 bg-white p-3" data-testid="reminder-filters">
        <select className="field" value={filters.state} onChange={(e) => setFilters({ ...filters, state: e.target.value })} aria-label="Status">
          <option value="all">All dated</option><option value="pending">Pending</option><option value="due_soon">Due soon</option><option value="overdue">Overdue</option><option value="no_due_date">No due date</option>
        </select>
        <select className="field" value={filters.regionId} onChange={(e) => setFilters({ ...filters, regionId: e.target.value })} aria-label="Region">
          <option value="">All my regions</option>{regions.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
        <select className="field" value={filters.managerId} onChange={(e) => setFilters({ ...filters, managerId: e.target.value })} aria-label="Manager">
          <option value="">Any manager</option>{managers.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
        <select className="field" value={filters.reminder} onChange={(e) => setFilters({ ...filters, reminder: e.target.value })} aria-label="Reminder status">
          <option value="">Any reminder</option><option value="unacknowledged">Not acknowledged</option><option value="acknowledged">Acknowledged</option><option value="escalated">Escalated</option><option value="no_recipient">No recipient</option><option value="failed">Delivery failed</option>
        </select>
        <input type="date" className="field" value={filters.from} onChange={(e) => setFilters({ ...filters, from: e.target.value })} aria-label="Due from" />
        <input type="date" className="field" value={filters.to} onChange={(e) => setFilters({ ...filters, to: e.target.value })} aria-label="Due to" />
      </div>

      {!data && !error && <p className="text-sm text-gray-500" data-testid="reminders-loading">Loading reminders…</p>}
      {data && data.rows.length === 0 && (
        <div className="rounded-xl border border-dashed border-gray-300 p-6 text-center text-sm text-gray-500" data-testid="reminders-empty">
          Nothing matches these filters. Activities only appear here once a due date has been set for them.
        </div>
      )}

      <ul className="space-y-3">
        {data?.rows.map((row) => {
          const label = reminderLabel(row.reminder, data.policy.remindersEnabled);
          return (
            <li key={row.key} data-testid={`reminder-row-${row.activityRef}`} className={`rounded-xl border bg-white p-4 space-y-2 ${focus && row.reminder?.id === focus ? "border-[var(--theme-accent)] ring-2 ring-[var(--theme-accent)]/20" : "border-gray-200"}`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-3">
                  <span className="font-mono text-sm font-bold text-[var(--theme-primary)]">{row.activityRef}</span>
                  <span className="text-xs text-gray-500">{row.activityType === "ticket" ? "Service ticket" : "AMC visit"}</span>
                  <span className={STATE_PILL[row.state]}>{STATE_LABEL[row.state]}</span>
                </div>
                <span className={label.cls}>{label.text}</span>
              </div>
              <dl className="grid grid-cols-2 sm:grid-cols-5 gap-x-4 gap-y-1 text-sm">
                <div><dt className="text-[10px] uppercase text-gray-400">Customer</dt><dd>{row.customerName}</dd></div>
                <div><dt className="text-[10px] uppercase text-gray-400">Site</dt><dd>{row.siteName ?? <span className="text-gray-400">not recorded</span>}</dd></div>
                <div><dt className="text-[10px] uppercase text-gray-400">RECD serial no.</dt><dd className="font-mono">{row.serialNo ?? <span className="text-amber-600" data-testid="serial-missing">not recorded</span>}</dd></div>
                <div><dt className="text-[10px] uppercase text-gray-400">Due date</dt><dd>{row.dueDate ?? "-"}</dd></div>
                <div><dt className="text-[10px] uppercase text-gray-400">Region / manager</dt><dd>{row.regionName ?? <span className="text-amber-600">no region</span>}{row.managers.length ? ` · ${row.managers.map((m) => m.name).join(", ")}` : row.regionId ? " · no active manager" : ""}</dd></div>
              </dl>
              {row.reminder?.acknowledgedAt && <p className="text-xs text-emerald-700">Acknowledged by {row.reminder.acknowledgedBy ?? "a manager"} on {new Date(row.reminder.acknowledgedAt).toLocaleString()}.</p>}
              {row.reminder && row.reminder.escalationLevel > 0 && <p className="text-xs text-red-700">Escalated to level {row.reminder.escalationLevel}{row.reminder.lastEscalatedAt ? ` on ${new Date(row.reminder.lastEscalatedAt).toLocaleString()}` : ""}.</p>}
              {(() => {
                const esc = escalationInfo(row.reminder, data.policy.reminderEscalationHours);
                return esc ? <p className={`text-xs ${esc.cls}`} data-testid={`escalation-${row.activityRef}`}>{esc.text}.</p> : null;
              })()}
              {row.activityType === "ticket" && row.state === "no_due_date" && (
                <div className="flex items-center gap-2" data-testid={`set-due-${row.activityRef}`}>
                  <input type="date" className="field" value={dueInput[row.key] ?? ""} onChange={(e) => setDueInput({ ...dueInput, [row.key]: e.target.value })} aria-label={`Due date for ${row.activityRef}`} />
                  <button type="button" onClick={() => saveDueDate(row)} disabled={busy === row.key || !dueInput[row.key]} className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium disabled:opacity-50">Set due date</button>
                </div>
              )}
              <div className="flex flex-wrap items-center gap-4 text-xs">
                {canAck && row.reminder && !row.reminder.acknowledgedAt && row.reminder.status === "sent" && (
                  <button type="button" onClick={() => acknowledge(row)} disabled={busy === row.key} className="btn-primary px-3 py-1.5 text-xs disabled:opacity-50" data-testid={`ack-${row.activityRef}`}>
                    {busy === row.key ? "Saving…" : "Acknowledge"}
                  </button>
                )}
                {row.links.activity && <Link href={row.links.activity} className="font-medium text-[var(--theme-accent)] hover:underline">Open {row.activityType === "ticket" ? "ticket reports" : "AMC orders"}</Link>}
                {row.links.unit && <Link href={row.links.unit} className="font-medium text-[var(--theme-accent)] hover:underline">RECD unit</Link>}
              </div>
              {row.reminder && row.reminder.events.length > 0 && (
                <details className="text-xs text-gray-600">
                  <summary className="cursor-pointer">History ({row.reminder.events.length})</summary>
                  <ul className="mt-1 space-y-0.5">
                    {row.reminder.events.map((e) => (
                      <li key={e.id}>{new Date(e.at).toLocaleString()} - {EVENT_TEXT[e.type] ?? e.type}{e.level ? ` (level ${e.level})` : ""}{e.recipient ? ` - ${e.recipient}` : ""}{e.channel ? ` via ${e.channel}` : ""}{attemptSuffix(e)}</li>
                    ))}
                  </ul>
                </details>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export default function RemindersPage() {
  return (
    <Suspense fallback={<p className="text-sm text-gray-500">Loading…</p>}>
      <Dashboard />
    </Suspense>
  );
}
