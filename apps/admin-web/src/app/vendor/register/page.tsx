"use client";

import { useState } from "react";
import Link from "next/link";
import { api } from "@/lib/apiClient";
import { apiErrorMessage } from "@/lib/apiError";
import { cleanMobile, mobileFieldError } from "@/lib/mobileInput";

export default function VendorRegisterPage() {
  const [form, setForm] = useState({ name: "", contactName: "", contactEmail: "", contactPhone: "", address: "" });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  function set(k: keyof typeof form, v: string) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const phoneError = mobileFieldError(form.contactPhone);
    if (phoneError) {
      setError(phoneError);
      return;
    }
    setLoading(true);
    try {
      await api("/vendors/register", {
        method: "POST",
        body: JSON.stringify({
          name: form.name,
          contactName: form.contactName,
          contactEmail: form.contactEmail,
          contactPhone: cleanMobile(form.contactPhone),
          address: form.address || undefined,
        }),
      });
      setDone(true);
    } catch (err) {
      setError(apiErrorMessage(err, "Registration failed"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-lg rounded-2xl border border-gray-200 bg-white p-8 shadow-xl">
        <div className="text-center mb-6">
          <h1 className="text-2xl font-bold tracking-tight text-gray-900">Vendor Registration</h1>
          <p className="mt-2 text-sm text-gray-500">
            Register your erection company to be considered as a Platino installation partner.
          </p>
        </div>

        {done ? (
          <div className="space-y-4 text-center">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-green-100 text-green-600">
              <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
              </svg>
            </div>
            <p className="text-sm text-gray-700">
              Thanks — your registration has been submitted. Platino management will review it (due diligence)
              and, once approved, send login details to <strong>{form.contactEmail}</strong>.
            </p>
            <Link href="/login" className="inline-block text-sm font-medium text-[var(--theme-accent)]">Back to sign in</Link>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-gray-500 mb-1">Company name</label>
              <input required className="w-full rounded-xl border border-gray-300 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--theme-accent)]/30 focus:border-[var(--theme-accent)]" value={form.name} onChange={(e) => set("name", e.target.value)} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-gray-500 mb-1">Contact name</label>
                <input required className="w-full rounded-xl border border-gray-300 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--theme-accent)]/30 focus:border-[var(--theme-accent)]" value={form.contactName} onChange={(e) => set("contactName", e.target.value)} />
              </div>
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-gray-500 mb-1">Contact phone</label>
                <input required inputMode="tel" title="10-digit Indian mobile number" className="w-full rounded-xl border border-gray-300 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--theme-accent)]/30 focus:border-[var(--theme-accent)]" value={form.contactPhone} onChange={(e) => set("contactPhone", e.target.value)} />
              </div>
            </div>
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-gray-500 mb-1">Contact email (your login)</label>
              <input required type="email" className="w-full rounded-xl border border-gray-300 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--theme-accent)]/30 focus:border-[var(--theme-accent)]" value={form.contactEmail} onChange={(e) => set("contactEmail", e.target.value)} />
            </div>
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-gray-500 mb-1">Address</label>
              <input className="w-full rounded-xl border border-gray-300 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--theme-accent)]/30 focus:border-[var(--theme-accent)]" value={form.address} onChange={(e) => set("address", e.target.value)} />
            </div>

            {error && <div className="rounded-lg bg-red-50 p-3 text-sm text-red-600">{error}</div>}

            <button type="submit" disabled={loading} className="btn-primary w-full py-2.5 text-sm font-semibold disabled:opacity-50">
              {loading ? "Submitting…" : "Submit registration"}
            </button>
            <p className="text-center text-xs text-gray-400">
              Already approved? <Link href="/login" className="text-[var(--theme-accent)] font-medium">Sign in</Link>
            </p>
          </form>
        )}
      </div>
    </div>
  );
}
