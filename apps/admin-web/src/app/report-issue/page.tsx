"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ISSUE_CATEGORY_LABELS, PUBLIC_OTP, REPORTER_TYPE_LABELS, canResend, otpExpiryText, resendLabel, tickCooldown } from "@recd/shared";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";

/** Public endpoints: no auth token, and never the app-wide 401 -> /login redirect. */
async function publicApi<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_URL}/public/complaints${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    let msg = `Request failed (${res.status})`;
    if (typeof data.error === "string") msg = data.error;
    else if (data.error?.fieldErrors) {
      const first = Object.values(data.error.fieldErrors as Record<string, string[]>).flat()[0];
      if (first) msg = first;
    }
    const err = new Error(msg) as Error & { retryAfterSeconds?: number };
    if (typeof data.retryAfterSeconds === "number") err.retryAfterSeconds = data.retryAfterSeconds;
    throw err;
  }
  return data as T;
}

const input =
  "w-full rounded-xl border border-gray-300 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--theme-accent)]/30 focus:border-[var(--theme-accent)]";
const label = "block text-xs font-semibold uppercase tracking-wider text-gray-500 mb-1";

type Step = "identify" | "otp" | "details" | "done";

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

export default function ReportIssuePage() {
  const [step, setStep] = useState<Step>("identify");
  const [serialNo, setSerialNo] = useState("");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [sessionToken, setSessionToken] = useState("");
  const [recd, setRecd] = useState<string | null>(null);
  const [reporterName, setReporterName] = useState("");
  const [reporterType, setReporterType] = useState("customer");
  const [issueCategory, setIssueCategory] = useState("");
  const [description, setDescription] = useState("");
  const [attachment, setAttachment] = useState<string | undefined>();
  const [ticket, setTicket] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);
  const [devCode, setDevCode] = useState<string | undefined>();
  const [expiresIn, setExpiresIn] = useState<number>(PUBLIC_OTP.EXPIRY_SECONDS);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => tickCooldown(c)), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  async function requestOtp(e?: React.FormEvent) {
    e?.preventDefault();
    setLoading(true);
    setError(null);
    setInfo(null);
    try {
      const r = await publicApi<{ message: string; resendAfterSeconds: number; expiresInSeconds?: number; devCode?: string }>("/otp/request", { serialNo, phone });
      setInfo(r.message);
      setCooldown(r.resendAfterSeconds);
      setExpiresIn(r.expiresInSeconds ?? PUBLIC_OTP.EXPIRY_SECONDS);
      setDevCode(r.devCode);
      setCode("");
      setStep("otp");
    } catch (err) {
      const wait = (err as { retryAfterSeconds?: number }).retryAfterSeconds;
      if (wait && wait < 120) setCooldown(wait);
      setError(err instanceof Error ? err.message : "Could not send the code");
    } finally {
      setLoading(false);
    }
  }

  async function verifyOtp(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const r = await publicApi<{ sessionToken: string; recd: string | null }>("/otp/verify", { serialNo, phone, code });
      setSessionToken(r.sessionToken);
      setRecd(r.recd);
      setStep("details");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Verification failed");
    } finally {
      setLoading(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const r = await publicApi<{ ticketNumber: string }>("/", {
        sessionToken, reporterName, reporterType, issueCategory, description, attachmentUrl: attachment,
      });
      setTicket(r.ticketNumber);
      setStep("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not raise the ticket");
    } finally {
      setLoading(false);
    }
  }

  async function onFile(f: File | undefined) {
    if (!f) return setAttachment(undefined);
    if (!/^image\/(png|jpe?g|webp)$/.test(f.type)) return setError("Attach a PNG, JPG or WebP photo");
    if (f.size > 5 * 1024 * 1024) return setError("Photo must be under 5 MB");
    setError(null);
    setAttachment(await fileToDataUrl(f));
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-lg rounded-2xl border border-gray-200 bg-white p-8 shadow-xl" data-testid="report-issue">
        <div className="mb-6 text-center">
          <h1 className="text-2xl font-bold tracking-tight text-gray-900">Report an issue with your RECD</h1>
          <p className="mt-2 text-sm text-gray-500">
            Owners, resellers and re-resellers can raise a service ticket using the RECD serial number and a mobile number verified by OTP.
          </p>
        </div>

        {step === "identify" && (
          <form onSubmit={requestOtp} className="space-y-4">
            <div>
              <label className={label}>RECD serial number</label>
              <input required className={input} value={serialNo} onChange={(e) => setSerialNo(e.target.value)} placeholder="As printed on the unit" />
            </div>
            <div>
              <label className={label}>Your mobile number (WhatsApp)</label>
              <input required inputMode="numeric" className={input} value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="10-digit mobile number" />
            </div>
            {error && <div className="rounded-lg bg-red-50 p-3 text-sm text-red-600">{error}</div>}
            <button type="submit" disabled={loading} className="btn-primary w-full py-2.5 text-sm font-semibold disabled:opacity-50">
              {loading ? "Sending…" : "Send OTP"}
            </button>
          </form>
        )}

        {step === "otp" && (
          <form onSubmit={verifyOtp} className="space-y-4">
            {info && <div className="rounded-lg bg-gray-50 p-3 text-sm text-gray-600">{info}</div>}
            {devCode && <div className="rounded-lg bg-amber-50 p-3 text-sm text-amber-700">Dev mode code: <strong>{devCode}</strong></div>}
            <div>
              <label className={label}>6-digit code</label>
              <input required inputMode="numeric" maxLength={6} className={input + " tracking-[0.4em] text-center text-lg"} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
            </div>
            {error && <div className="rounded-lg bg-red-50 p-3 text-sm text-red-600">{error}</div>}
            <p className="text-xs text-gray-500">The code is valid for {otpExpiryText(expiresIn)}. If it expires or is wrong too many times, request a new one.</p>
            <button type="submit" disabled={loading || code.length !== 6} className="btn-primary w-full py-2.5 text-sm font-semibold disabled:opacity-50">
              {loading ? "Verifying…" : "Verify"}
            </button>
            <div className="flex items-center justify-between text-xs">
              <button type="button" onClick={() => { setStep("identify"); setError(null); }} className="font-medium text-gray-500">Change details</button>
              <button type="button" disabled={!canResend(cooldown, loading)} onClick={() => requestOtp()} className="font-medium text-[var(--theme-accent)] disabled:text-gray-400">
                {resendLabel(cooldown)}
              </button>
            </div>
          </form>
        )}

        {step === "details" && (
          <form onSubmit={submit} className="space-y-4">
            <div className="rounded-lg bg-green-50 p-3 text-sm text-green-700">
              Mobile verified{recd ? <> for <strong>{recd}</strong> · serial <strong>{serialNo.toUpperCase()}</strong></> : null}.
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={label}>Your name</label>
                <input required minLength={2} className={input} value={reporterName} onChange={(e) => setReporterName(e.target.value)} />
              </div>
              <div>
                <label className={label}>You are the</label>
                <select className={input} value={reporterType} onChange={(e) => setReporterType(e.target.value)}>
                  {Object.entries(REPORTER_TYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </div>
            </div>
            <div>
              <label className={label}>What is the problem?</label>
              <select required className={input} value={issueCategory} onChange={(e) => setIssueCategory(e.target.value)}>
                <option value="">Select…</option>
                {Object.entries(ISSUE_CATEGORY_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </div>
            <div>
              <label className={label}>Describe the issue</label>
              <textarea required minLength={10} maxLength={2000} rows={4} className={input} value={description} onChange={(e) => setDescription(e.target.value)} />
            </div>
            <div>
              <label className={label}>Photo (optional)</label>
              <input type="file" accept="image/png,image/jpeg,image/webp" className="text-sm" onChange={(e) => onFile(e.target.files?.[0])} />
            </div>
            {error && <div className="rounded-lg bg-red-50 p-3 text-sm text-red-600">{error}</div>}
            <button type="submit" disabled={loading || !issueCategory} className="btn-primary w-full py-2.5 text-sm font-semibold disabled:opacity-50">
              {loading ? "Submitting…" : "Raise service ticket"}
            </button>
          </form>
        )}

        {step === "done" && (
          <div className="space-y-4 text-center">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-green-100 text-green-600">
              <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
              </svg>
            </div>
            <p className="text-sm text-gray-700">Your service ticket has been raised. Quote this number when you contact us:</p>
            <p className="font-mono text-xl font-bold text-gray-900" data-testid="ticket-number">{ticket}</p>
            <p className="text-xs text-gray-500">Our service team has been notified and will reach you on {phone}.</p>
          </div>
        )}

        <p className="mt-6 text-center text-xs text-gray-400">
          Platino staff? <Link href="/login" className="font-medium text-[var(--theme-accent)]">Sign in</Link>
        </p>
      </div>
    </div>
  );
}
