"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/apiClient";
import { apiErrorMessage } from "@/lib/apiError";
import { AMC_DEFAULTS } from "@recd/shared";

/** AMC default duration and expiry-reminder timing. An empty box keeps the built-in default (12 months, 30 days before the end, every 3 days). */
export default function AmcSettings() {
  const [months, setMonths] = useState("");
  const [lead, setLead] = useState("");
  const [repeat, setRepeat] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    api<{ amcDefaultDurationMonths?: number | null; amcReminderLeadDays?: number | null; amcReminderRepeatDays?: number | null }>("/settings")
      .then((s) => {
        setMonths(s.amcDefaultDurationMonths == null ? "" : String(s.amcDefaultDurationMonths));
        setLead(s.amcReminderLeadDays == null ? "" : String(s.amcReminderLeadDays));
        setRepeat(s.amcReminderRepeatDays == null ? "" : String(s.amcReminderRepeatDays));
      })
      .catch(() => {});
  }, []);

  const num = (v: string) => (v.trim() === "" ? null : Number(v));

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setMessage(null);
    try {
      await api("/settings/amc", { method: "PUT", body: JSON.stringify({ amcDefaultDurationMonths: num(months), amcReminderLeadDays: num(lead), amcReminderRepeatDays: num(repeat) }) });
      setMessage({ ok: true, text: "Saved. New contracts and the AMC reminders use these values." });
    } catch (err) {
      setMessage({ ok: false, text: apiErrorMessage(err, "Could not save the AMC settings.") });
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="rounded-xl border border-gray-200 bg-white p-4 sm:p-6" data-testid="amc-settings">
      <h2 className="text-base font-semibold text-gray-900">AMC duration and expiry reminders</h2>
      <p className="mt-1 text-sm text-gray-500">
        Leave a box empty to keep the default ({AMC_DEFAULTS.DURATION_MONTHS} months, reminders from {AMC_DEFAULTS.REMINDER_LEAD_DAYS} days before the end date, repeated every {AMC_DEFAULTS.REMINDER_REPEAT_DAYS} days).
        The same &quot;expiring soon&quot; window drives the status shown on AMC pages and the login-time notice.
      </p>
      <form onSubmit={save} className="mt-4 grid gap-4 sm:grid-cols-3">
        <label className="block text-sm">
          <span className="block text-xs font-medium text-gray-500 mb-1">Default duration (months)</span>
          <input type="number" min={1} max={120} className="field w-full" value={months} onChange={(e) => setMonths(e.target.value)} placeholder={`default ${AMC_DEFAULTS.DURATION_MONTHS}`} data-testid="amc-setting-months" />
        </label>
        <label className="block text-sm">
          <span className="block text-xs font-medium text-gray-500 mb-1">Remind from (days before the end date)</span>
          <input type="number" min={0} max={365} className="field w-full" value={lead} onChange={(e) => setLead(e.target.value)} placeholder={`default ${AMC_DEFAULTS.REMINDER_LEAD_DAYS}`} data-testid="amc-setting-lead" />
        </label>
        <label className="block text-sm">
          <span className="block text-xs font-medium text-gray-500 mb-1">Repeat every (days)</span>
          <input type="number" min={1} max={90} className="field w-full" value={repeat} onChange={(e) => setRepeat(e.target.value)} placeholder={`default ${AMC_DEFAULTS.REMINDER_REPEAT_DAYS}`} data-testid="amc-setting-repeat" />
        </label>
        <div className="sm:col-span-3 flex items-center gap-3">
          <button type="submit" disabled={saving} className="btn-primary px-4 py-2 text-sm disabled:opacity-50" data-testid="amc-settings-save">{saving ? "Saving…" : "Save AMC settings"}</button>
          {message && <span role="status" className={`text-sm ${message.ok ? "text-emerald-700" : "text-red-600"}`} data-testid="amc-settings-message">{message.text}</span>}
        </div>
      </form>
    </section>
  );
}
