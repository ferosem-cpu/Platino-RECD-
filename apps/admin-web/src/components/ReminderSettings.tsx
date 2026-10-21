"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/apiClient";
import { apiErrorMessage } from "@/lib/apiError";
import { PROPOSED_REMINDER_POLICY } from "@recd/shared";

/**
 * Reminder policy for service activities with a due date (Requirement 6). Both fields EMPTY = off: nothing is reminded and
 * nothing is escalated. The business has not approved values yet, so none are pre-filled.
 */
export default function ReminderSettings() {
  const [lead, setLead] = useState("");
  const [hours, setHours] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    api<{ reminderLeadDays?: number | null; reminderEscalationHours?: number | null }>("/settings")
      .then((s) => {
        setLead(s.reminderLeadDays == null ? "" : String(s.reminderLeadDays));
        setHours(s.reminderEscalationHours == null ? "" : String(s.reminderEscalationHours));
      })
      .catch(() => {});
  }, []);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setMessage(null);
    try {
      await api("/settings/reminders", {
        method: "PUT",
        body: JSON.stringify({ reminderLeadDays: lead.trim() === "" ? null : Number(lead), reminderEscalationHours: hours.trim() === "" ? null : Number(hours) }),
      });
      setMessage({ ok: true, text: lead.trim() === "" ? "Saved. Reminders are OFF." : "Saved. The daily job will now send reminders." });
    } catch (err) {
      setMessage({ ok: false, text: apiErrorMessage(err, "Could not save the reminder policy.") });
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="rounded-xl border border-gray-200 bg-white p-4 sm:p-6" data-testid="reminder-settings">
      <h2 className="text-base font-semibold text-gray-900">Service reminders (due dates)</h2>
      <p className="mt-1 text-sm text-gray-500">
        Reminders go to the Service Managers mapped to the activity&apos;s region. Leave both boxes empty to keep reminders switched off. These are separate from the ticket-age SLA above.
      </p>
      <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900" data-testid="reminder-proposed-policy">
        <p className="font-medium">Proposed workflow (for mentor review - not active)</p>
        <ol className="mt-1 list-decimal pl-5 text-xs space-y-0.5">
          <li>First reminder {PROPOSED_REMINDER_POLICY.reminderLeadDays} days before the due date, to the region&apos;s Service Managers.</li>
          <li>Not acknowledged {PROPOSED_REMINDER_POLICY.reminderEscalationHours} hours after it was delivered: escalate to the region&apos;s Regional Managers.</li>
          <li>Still not acknowledged {PROPOSED_REMINDER_POLICY.reminderEscalationHours} hours after that escalation was delivered: escalate to Management.</li>
        </ol>
        <button type="button" onClick={() => { setLead(String(PROPOSED_REMINDER_POLICY.reminderLeadDays)); setHours(String(PROPOSED_REMINDER_POLICY.reminderEscalationHours)); setMessage(null); }} className="mt-2 rounded-lg border border-amber-300 bg-white px-3 py-1 text-xs font-medium" data-testid="reminder-fill-proposed">
          Fill in the proposed values
        </button>
        <span className="ml-2 text-[11px]">This only fills the boxes below. Nothing changes, and reminders stay off, until the policy is saved here in the environment you are using.</span>
      </div>
      <form onSubmit={save} className="mt-4 grid gap-4 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="block text-xs font-medium text-gray-500 mb-1">Remind this many days before the due date (and for everything overdue)</span>
          <input type="number" min={0} max={365} className="field w-full" value={lead} onChange={(e) => setLead(e.target.value)} placeholder="empty = off" data-testid="reminder-lead-days" />
        </label>
        <label className="block text-sm">
          <span className="block text-xs font-medium text-gray-500 mb-1">Escalate a reminder nobody acknowledged after (hours)</span>
          <input type="number" min={1} className="field w-full" value={hours} onChange={(e) => setHours(e.target.value)} placeholder="empty = no escalation" disabled={lead.trim() === ""} data-testid="reminder-escalation-hours" />
        </label>
        <div className="sm:col-span-2 flex items-center gap-3">
          <button type="submit" disabled={saving} className="btn-primary px-4 py-2 text-sm disabled:opacity-50">{saving ? "Saving…" : "Save reminder policy"}</button>
          {message && <span role="status" className={`text-sm ${message.ok ? "text-emerald-700" : "text-red-600"}`}>{message.text}</span>}
        </div>
      </form>
      <p className="mt-3 text-[11px] text-gray-400">
        Escalation goes to the region&apos;s Regional Managers first and then to Management, once per level. The exact recipients and timing still need the business&apos;s approval.
      </p>
    </section>
  );
}
