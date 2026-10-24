"use client";

import { useEffect, useRef, useState } from "react";
import Script from "next/script";
import { useAuth } from "@/components/AuthContext";
import { api, ApiRequestError } from "@/lib/apiClient";
import { apiErrorMessage } from "@/lib/apiError";
import { cleanMobile, mobileFieldError } from "@/lib/mobileInput";
import {
  LOGIN_OTP_POLICY,
  canResend,
  otpErrorText,
  otpExpiryText,
  otpRequestedNotice,
  resendLabel,
  tickCooldown,
  type OtpRequestResult,
} from "@recd/shared";

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (config: { client_id: string; callback: (response: { credential: string }) => void }) => void;
          renderButton: (parent: HTMLElement, options: Record<string, unknown>) => void;
        };
      };
    };
  }
}

type Tab = "staff" | "customer" | "vendor";

const inputCls =
  "w-full rounded-xl border border-gray-300 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--theme-accent)]/30 focus:border-[var(--theme-accent)] transition";
const labelCls = "block text-xs font-semibold uppercase tracking-wider text-gray-500 mb-1";

export default function LoginPage() {
  const { login } = useAuth();
  const [activeTab, setActiveTab] = useState<Tab>("staff");

  // Staff Login State
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [staffError, setStaffError] = useState<string | null>(null);
  const [staffLoading, setStaffLoading] = useState(false);

  // Google sign-in - an ADDITIONAL staff login method only. Deliberately rendered inside the
  // Staff tab and nowhere else: the Customer tab below stays RECD Serial Number + phone + OTP,
  // and POST /auth/google rejects customer accounts server-side too.
  const googleButtonRef = useRef<HTMLDivElement>(null);
  const [googleError, setGoogleError] = useState<string | null>(null);

  async function handleGoogleCredential(response: { credential: string }) {
    setGoogleError(null);
    try {
      const result = await api<{ token: string; user: { name: string } }>("/auth/google", {
        method: "POST",
        body: JSON.stringify({ credential: response.credential }),
      });
      await login(result.token);
    } catch (err) {
      setGoogleError(err instanceof Error ? err.message : "Google sign-in failed");
    }
  }

  function initGoogleButton() {
    const clientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
    if (!clientId || !window.google || !googleButtonRef.current) return;
    window.google.accounts.id.initialize({ client_id: clientId, callback: handleGoogleCredential });
    window.google.accounts.id.renderButton(googleButtonRef.current, { theme: "outline", size: "large", width: 300 });
  }

  useEffect(() => {
    // The GSI script may already be loaded/cached from a previous visit, in which case
    // next/script's onLoad won't fire again - so also try once on mount.
    initGoogleButton();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  // Customer Login State
  const [orderNumber, setOrderNumber] = useState("");
  const [phone, setPhone] = useState("");
  const [otpCode, setOtpCode] = useState("");
  const [otpSent, setOtpSent] = useState(false);
  const [otpMessage, setOtpMessage] = useState<string | null>(null);
  // Resend cooldown (seconds left) and the notice the server's answer produced. The server enforces the
  // cooldown and limits itself; this only mirrors them so the user is not left guessing.
  const [cooldown, setCooldown] = useState(0);
  const [otpNotice, setOtpNotice] = useState<string | null>(null);
  const [expiresInSeconds, setExpiresInSeconds] = useState<number>(LOGIN_OTP_POLICY.EXPIRY_SECONDS);
  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => tickCooldown(c)), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);
  const [customerError, setCustomerError] = useState<string | null>(null);
  const [customerLoading, setCustomerLoading] = useState(false);

  // Vendor Registration State
  const [vendor, setVendor] = useState({ name: "", contactName: "", contactEmail: "", contactPhone: "", address: "" });
  const [vendorError, setVendorError] = useState<string | null>(null);
  const [vendorLoading, setVendorLoading] = useState(false);
  const [vendorDone, setVendorDone] = useState(false);

  function clearErrors() {
    setStaffError(null);
    setCustomerError(null);
    setVendorError(null);
  }

  async function handleStaffSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStaffLoading(true);
    setStaffError(null);
    try {
      const result = await api<{ token: string; user: { name: string } }>("/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      await login(result.token);
    } catch (err) {
      setStaffError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setStaffLoading(false);
    }
  }

  async function requestCustomerOtp() {
    setCustomerError(null);
    setOtpMessage(null);
    const phoneError = mobileFieldError(phone);
    if (phoneError) {
      setCustomerError(phoneError);
      return;
    }
    setCustomerLoading(true);
    try {
      const result = await api<OtpRequestResult & { ok: boolean; devCode?: string }>("/auth/customer/register", {
        method: "POST",
        body: JSON.stringify({ orderNumber, phone: cleanMobile(phone) }),
      });
      setOtpSent(true);
      setCooldown(result.resendAfterSeconds ?? LOGIN_OTP_POLICY.RESEND_COOLDOWN_SECONDS);
      setExpiresInSeconds(result.expiresInSeconds ?? LOGIN_OTP_POLICY.EXPIRY_SECONDS);
      setOtpNotice(otpRequestedNotice(result, LOGIN_OTP_POLICY.EXPIRY_SECONDS));
      // Only present when the API runs in explicitly enabled local-development mode (nothing was sent).
      setOtpMessage(result.devCode ?? null);
    } catch (err) {
      const status = err instanceof ApiRequestError ? err.status : undefined;
      const retryAfterSeconds = err instanceof ApiRequestError ? Number(err.body.retryAfterSeconds) || undefined : undefined;
      if (status === 429 && retryAfterSeconds && retryAfterSeconds < 120) setCooldown(retryAfterSeconds);
      setCustomerError(otpErrorText("request", { status, message: apiErrorMessage(err, ""), retryAfterSeconds }));
    } finally {
      setCustomerLoading(false);
    }
  }

  async function handleCustomerRequestOtp(e: React.FormEvent) {
    e.preventDefault();
    await requestCustomerOtp();
  }

  async function handleCustomerVerifyOtp(e: React.FormEvent) {
    e.preventDefault();
    setCustomerError(null);
    const phoneError = mobileFieldError(phone);
    if (phoneError) {
      setCustomerError(phoneError);
      return;
    }
    setCustomerLoading(true);
    try {
      const result = await api<{ token: string; user: { name: string; orderNumber: string } }>("/auth/customer/verify", {
        method: "POST",
        body: JSON.stringify({ orderNumber, phone: cleanMobile(phone), code: otpCode }),
      });
      await login(result.token, result.user.orderNumber);
    } catch (err) {
      const status = err instanceof ApiRequestError ? err.status : undefined;
      setCustomerError(otpErrorText("verify", { status, message: apiErrorMessage(err, ""), retryAfterSeconds: err instanceof ApiRequestError ? Number(err.body.retryAfterSeconds) || undefined : undefined }));
    } finally {
      setCustomerLoading(false);
    }
  }

  async function handleVendorRegister(e: React.FormEvent) {
    e.preventDefault();
    setVendorError(null);
    const phoneError = mobileFieldError(vendor.contactPhone);
    if (phoneError) {
      setVendorError(phoneError);
      return;
    }
    setVendorLoading(true);
    try {
      await api("/vendors/register", {
        method: "POST",
        body: JSON.stringify({
          name: vendor.name,
          contactName: vendor.contactName,
          contactEmail: vendor.contactEmail,
          contactPhone: cleanMobile(vendor.contactPhone),
          address: vendor.address || undefined,
        }),
      });
      setVendorDone(true);
    } catch (err) {
      setVendorError(apiErrorMessage(err, "Registration failed"));
    } finally {
      setVendorLoading(false);
    }
  }

  const tabs: { key: Tab; label: string }[] = [
    { key: "staff", label: "Staff Login" },
    { key: "customer", label: "Track Order" },
    { key: "vendor", label: "Vendor" },
  ];

  return (
    <div className="flex min-h-[90vh] items-center justify-center p-4" data-testid="login-page">
      <div className="w-full max-w-md rounded-2xl border border-gray-200 bg-white p-8 shadow-xl">
        <div className="text-center mb-6">
          <h1 className="text-2xl font-bold tracking-tight text-gray-900">RECD Tracker</h1>
          <p className="mt-2 text-sm text-gray-500">Project & Service Management System</p>
        </div>

        {/* Tab Headers */}
        <div className="flex border-b border-gray-100 mb-6">
          {tabs.map((t) => (
            <button
              key={t.key}
              data-testid={`login-tab-${t.key}`}
              onClick={() => {
                setActiveTab(t.key);
                clearErrors();
              }}
              className={`flex-1 pb-3 text-xs sm:text-sm font-semibold border-b-2 transition-colors ${
                activeTab === t.key
                  ? "border-[var(--theme-accent)] text-gray-900"
                  : "border-transparent text-gray-400 hover:text-gray-600"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Staff Sign In Tab */}
        {activeTab === "staff" && (
          <form onSubmit={handleStaffSubmit} className="space-y-4">
            <div>
              <label className={labelCls}>User Name</label>
              <input type="email" required className={inputCls} value={email} onChange={(e) => setEmail(e.target.value)} />
              <p className="mt-1 text-[11px] text-gray-400">Only users who have created and registered an account can sign in.</p>
            </div>
            <div>
              <label className={labelCls}>Password</label>
              <input type="password" required className={inputCls} value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
            {staffError && <div className="rounded-lg bg-red-50 p-3 text-sm text-red-600">{staffError}</div>}
            <button type="submit" disabled={staffLoading} className="btn-primary w-full py-2.5 text-sm font-semibold disabled:opacity-50">
              {staffLoading ? "Signing in..." : "Sign in"}
            </button>

            {process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID && (
              <>
                <div className="flex items-center gap-3 pt-1">
                  <div className="h-px flex-1 bg-gray-200" />
                  <span className="text-xs text-gray-400">or</span>
                  <div className="h-px flex-1 bg-gray-200" />
                </div>
                {googleError && <div className="rounded-lg bg-red-50 p-3 text-sm text-red-600">{googleError}</div>}
                <div className="flex justify-center" data-testid="google-signin-button" ref={googleButtonRef} />
                <Script src="https://accounts.google.com/gsi/client" strategy="afterInteractive" onLoad={initGoogleButton} />
              </>
            )}
          </form>
        )}

        {/* Customer Portal OTP Tab */}
        {activeTab === "customer" && (
          <div className="space-y-4">
            {!otpSent ? (
              <form onSubmit={handleCustomerRequestOtp} className="space-y-4">
                <div>
                  <label className={labelCls}>RECD Serial Number</label>
                  <input type="text" required placeholder="RECD serial number or order number" className={inputCls} value={orderNumber} onChange={(e) => setOrderNumber(e.target.value)} />
                </div>
                <div>
                  <label className={labelCls}>Phone Number</label>
                  <input
                    type="tel"
                    required
                    inputMode="tel"
                    title="10-digit Indian mobile number"
                    placeholder="e.g. +919900011122"
                    className={inputCls}
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                  />
                </div>
                <p className="text-[11px] text-gray-400 -mt-2">
                  The one-time code is sent by WhatsApp to the mobile number registered for this order. Only one complaint may be open against a
                  RECD serial number at a time.
                </p>
                {customerError && <div className="rounded-lg bg-red-50 p-3 text-sm text-red-600">{customerError}</div>}
                <button type="submit" disabled={customerLoading} className="btn-primary w-full py-2.5 text-sm font-semibold disabled:opacity-50">
                  {customerLoading ? "Sending code..." : "Send code to my mobile"}
                </button>
              </form>
            ) : (
              <form onSubmit={handleCustomerVerifyOtp} className="space-y-4">
                {otpMessage && (
                  <div className="rounded-lg bg-amber-50 border border-amber-100 p-3 text-sm text-amber-800">
                    <p className="font-medium">Development mode - nothing was sent to a phone. Code:</p>
                    <p className="mt-1 font-mono font-bold text-base tracking-wider">{otpMessage}</p>
                  </div>
                )}
                {!otpMessage && otpNotice && (
                  <div className="rounded-lg bg-emerald-50 border border-emerald-100 p-3 text-sm text-emerald-800">
                    {otpNotice} Check WhatsApp on your registered mobile number.
                  </div>
                )}
                <div>
                  <label className={labelCls}>Enter 6-digit OTP</label>
                  <input type="text" required maxLength={6} placeholder="123456" className={`${inputCls} font-mono tracking-widest text-center`} value={otpCode} onChange={(e) => setOtpCode(e.target.value)} />
                </div>
                {customerError && <div className="rounded-lg bg-red-50 p-3 text-sm text-red-600">{customerError}</div>}
                <div className="flex items-center justify-between text-xs text-gray-500">
                  <span>Code valid for {otpExpiryText(expiresInSeconds)}.</span>
                  <button
                    type="button"
                    disabled={!canResend(cooldown, customerLoading)}
                    onClick={() => void requestCustomerOtp()}
                    className="font-medium text-[var(--theme-accent)] disabled:text-gray-400"
                  >
                    {resendLabel(cooldown)}
                  </button>
                </div>
                <div className="flex gap-2">
                  <button type="button" onClick={() => { setOtpSent(false); setOtpCode(""); }} className="flex-1 rounded-xl border border-gray-300 px-3 py-2.5 text-sm font-semibold text-gray-700 hover:bg-gray-50 transition-colors">
                    Back
                  </button>
                  <button type="submit" disabled={customerLoading} className="flex-[2] btn-primary py-2.5 text-sm font-semibold disabled:opacity-50">
                    {customerLoading ? "Verifying..." : "Verify & Track Order"}
                  </button>
                </div>
              </form>
            )}
          </div>
        )}

        {/* Vendor Registration Tab */}
        {activeTab === "vendor" && (
          <div className="space-y-4" data-testid="vendor-register-form">
            {vendorDone ? (
              <div className="space-y-3 text-center">
                <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-green-100 text-green-600">
                  <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                  </svg>
                </div>
                <p className="text-sm text-gray-700">
                  Thanks — your registration was submitted. Platino management will review it and, once approved,
                  email login details to <strong>{vendor.contactEmail}</strong>.
                </p>
                <button
                  type="button"
                  onClick={() => { setVendorDone(false); setVendor({ name: "", contactName: "", contactEmail: "", contactPhone: "", address: "" }); }}
                  className="text-xs font-medium text-[var(--theme-accent)]"
                >
                  Register another company
                </button>
              </div>
            ) : (
              <form onSubmit={handleVendorRegister} className="space-y-4">
                <p className="rounded-lg bg-gray-50 border border-gray-100 p-3 text-xs text-gray-600">
                  Erection vendor? Register your company for approval. <strong>Already approved?</strong> Sign in under the
                  Staff Login tab with your email.
                </p>
                <div>
                  <label className={labelCls}>Company name</label>
                  <input required className={inputCls} value={vendor.name} onChange={(e) => setVendor({ ...vendor, name: e.target.value })} />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className={labelCls}>Contact name</label>
                    <input required className={inputCls} value={vendor.contactName} onChange={(e) => setVendor({ ...vendor, contactName: e.target.value })} />
                  </div>
                  <div>
                    <label className={labelCls}>Contact phone</label>
                    <input required inputMode="tel" title="10-digit Indian mobile number" className={inputCls} value={vendor.contactPhone} onChange={(e) => setVendor({ ...vendor, contactPhone: e.target.value })} />
                  </div>
                </div>
                <div>
                  <label className={labelCls}>Contact email (your login)</label>
                  <input required type="email" className={inputCls} value={vendor.contactEmail} onChange={(e) => setVendor({ ...vendor, contactEmail: e.target.value })} />
                </div>
                <div>
                  <label className={labelCls}>Address</label>
                  <input className={inputCls} value={vendor.address} onChange={(e) => setVendor({ ...vendor, address: e.target.value })} />
                </div>
                {vendorError && <div className="rounded-lg bg-red-50 p-3 text-sm text-red-600">{vendorError}</div>}
                <button type="submit" disabled={vendorLoading} className="btn-primary w-full py-2.5 text-sm font-semibold disabled:opacity-50">
                  {vendorLoading ? "Submitting..." : "Submit registration"}
                </button>
              </form>
            )}
          </div>
        )}

        <p className="mt-6 text-center text-xs text-gray-400">
          Have a problem with your RECD? <a href="/report-issue" className="font-medium text-[var(--theme-accent)]" data-testid="report-issue-link">Report an issue</a>
        </p>
      </div>
    </div>
  );
}
