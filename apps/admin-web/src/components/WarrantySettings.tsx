"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/apiClient";
import { apiErrorMessage } from "@/lib/apiError";
import { WARRANTY_DEFAULTS } from "@recd/shared";

/** Warranty reminder timing and the "expiring soon" window. Separate from the AMC settings. An empty box keeps the default (30 days before expiry, every 3 days). */
export default function WarrantySettings() {
  const [lead, setLead] = useState("");
  const [repeat, setRepeat] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    api<{ warrantyReminderLeadDays?: number | null; warrantyReminderRepeatDays?: number | null }>("/settings")
      .then((s) => {
        setLead(s.warrantyReminderLeadDays == null ? "" : String(s.warrantyReminderLeadDays));
        setRepeat(s.warrantyReminderRepeatDays == null ? "" : String(s.warrantyReminderRepeatDays));
      })
      .catch(() => {});
  }, []);

  const num = (v: string) => (v.trim() === "" ? null : Number(v));

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setMessage(null);
    try {
      await api("/settings/warranty", { method: "PUT", body: JSON.stringify({ warrantyReminderLeadDays: num(lead), warrantyReminderRepeatDays: num(repeat) }) });
      setMessage({ ok: true, text: "Saved. The warranty status window and reminders use these values." });
    } catch (err) {
      setMessage({ ok: false, text: apiErrorMessage(err, "Could not save the warranty settings.") });
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="rounded-xl border border-gray-200 bg-white p-4 sm:p-6" data-testid="warranty-settings">
      <h2 className="text-base font-semibold text-gray-900">RECD unit warranty reminders</h2>
      <p className="mt-1 text-sm text-gray-500">
        Leave a box empty to keep the default ({WARRANTY_DEFAULTS.REMINDER_LEAD_DAYS} days before the expiry date, repeated every {WARRANTY_DEFAULTS.REMINDER_REPEAT_DAYS} days). These defaults copy the AMC reminders; they are not a separately approved warranty policy.
        The same window drives the &quot;Near Expiry&quot; status and the login-time warranty notice. The reminder job runs daily (04:30 UTC) where the deployment has CRON_SECRET and an e-mail provider configured; reminders go to staff who can record warranty.
      </p>
      <form onSubmit={save} className="mt-4 grid gap-4 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="block text-xs font-medium text-gray-500 mb-1">Remind from (days before the expiry date)</span>
          <input type="number" min={0} max={365} className="field w-full" value={lead} onChange={(e) => setLead(e.target.value)} placeholder={`default ${WARRANTY_DEFAULTS.REMINDER_LEAD_DAYS}`} data-testid="warranty-setting-lead" />
        </label>
        <label className="block text-sm">
          <span className="block text-xs font-medium text-gray-500 mb-1">Repeat every (days)</span>
          <input type="number" min={1} max={90} className="field w-full" value={repeat} onChange={(e) => setRepeat(e.target.value)} placeholder={`default ${WARRANTY_DEFAULTS.REMINDER_REPEAT_DAYS}`} data-testid="warranty-setting-repeat" />
        </label>
        <div className="sm:col-span-2 flex items-center gap-3">
          <button type="submit" disabled={saving} className="btn-primary px-4 py-2 text-sm disabled:opacity-50" data-testid="warranty-settings-save">{saving ? "Saving…" : "Save warranty settings"}</button>
          {message && <span role="status" className={`text-sm ${message.ok ? "text-emerald-700" : "text-red-600"}`} data-testid="warranty-settings-message">{message.text}</span>}
        </div>
      </form>
    </section>
  );
}
