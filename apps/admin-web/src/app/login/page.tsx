"use client";

import { useState } from "react";
import { useAuth } from "@/components/AuthContext";
import { api } from "@/lib/apiClient";

type Tab = "staff" | "customer" | "vendor";

const inputCls =
  "w-full rounded-xl border border-gray-300 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--theme-accent)]/30 focus:border-[var(--theme-accent)] transition";
const labelCls = "block text-xs font-semibold uppercase tracking-wider text-gray-500 mb-1";

export default function LoginPage() {
  const { login } = useAuth();
  const [activeTab, setActiveTab] = useState<Tab>("staff");

  // Staff Login State
  const [email, setEmail] = useState("owner@platino.example");
  const [password, setPassword] = useState("changeme123");
  const [staffError, setStaffError] = useState<string | null>(null);
  const [staffLoading, setStaffLoading] = useState(false);

  // Customer Login State
  const [orderNumber, setOrderNumber] = useState("ORD-2026-0001");
  const [phone, setPhone] = useState("+919900011122");
  const [otpCode, setOtpCode] = useState("");
  const [otpSent, setOtpSent] = useState(false);
  const [otpMessage, setOtpMessage] = useState<string | null>(null);
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

  async function handleCustomerRequestOtp(e: React.FormEvent) {
    e.preventDefault();
    setCustomerLoading(true);
    setCustomerError(null);
    setOtpMessage(null);
    try {
      const result = await api<{ ok: boolean; message: string; devCode?: string }>("/auth/customer/register", {
        method: "POST",
        body: JSON.stringify({ orderNumber, phone }),
      });
      setOtpSent(true);
      // In production the code only arrives by email; in dev the API echoes it back so we can test.
      setOtpMessage(result.devCode ?? null);
    } catch (err) {
      setCustomerError(err instanceof Error ? err.message : "Failed to send OTP");
    } finally {
      setCustomerLoading(false);
    }
  }

  async function handleCustomerVerifyOtp(e: React.FormEvent) {
    e.preventDefault();
    setCustomerLoading(true);
    setCustomerError(null);
    try {
      const result = await api<{ token: string; user: { name: string; orderNumber: string } }>("/auth/customer/verify", {
        method: "POST",
        body: JSON.stringify({ orderNumber, phone, code: otpCode }),
      });
      await login(result.token, result.user.orderNumber);
    } catch (err) {
      setCustomerError(err instanceof Error ? err.message : "OTP verification failed");
    } finally {
      setCustomerLoading(false);
    }
  }

  async function handleVendorRegister(e: React.FormEvent) {
    e.preventDefault();
    setVendorLoading(true);
    setVendorError(null);
    try {
      await api("/vendors/register", {
        method: "POST",
        body: JSON.stringify({
          name: vendor.name,
          contactName: vendor.contactName,
          contactEmail: vendor.contactEmail,
          contactPhone: vendor.contactPhone || undefined,
          address: vendor.address || undefined,
        }),
      });
      setVendorDone(true);
    } catch (err) {
      setVendorError(err instanceof Error ? err.message : "Registration failed");
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
              <label className={labelCls}>Email</label>
              <input type="email" required className={inputCls} value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <div>
              <label className={labelCls}>Password</label>
              <input type="password" required className={inputCls} value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
            {staffError && <div className="rounded-lg bg-red-50 p-3 text-sm text-red-600">{staffError}</div>}
            <button type="submit" disabled={staffLoading} className="btn-primary w-full py-2.5 text-sm font-semibold disabled:opacity-50">
              {staffLoading ? "Signing in..." : "Sign in"}
            </button>
          </form>
        )}

        {/* Customer Portal OTP Tab */}
        {activeTab === "customer" && (
          <div className="space-y-4">
            {!otpSent ? (
              <form onSubmit={handleCustomerRequestOtp} className="space-y-4">
                <div>
                  <label className={labelCls}>Order ID</label>
                  <input type="text" required placeholder="e.g. ORD-2026-0001" className={inputCls} value={orderNumber} onChange={(e) => setOrderNumber(e.target.value)} />
                </div>
                <div>
                  <label className={labelCls}>Phone Number</label>
                  <input type="tel" required placeholder="e.g. +919900011122" className={inputCls} value={phone} onChange={(e) => setPhone(e.target.value)} />
                </div>
                {customerError && <div className="rounded-lg bg-red-50 p-3 text-sm text-red-600">{customerError}</div>}
                <button type="submit" disabled={customerLoading} className="btn-primary w-full py-2.5 text-sm font-semibold disabled:opacity-50">
                  {customerLoading ? "Sending OTP..." : "Get One-Time Password"}
                </button>
              </form>
            ) : (
              <form onSubmit={handleCustomerVerifyOtp} className="space-y-4">
                {otpMessage ? (
                  <div className="rounded-lg bg-amber-50 border border-amber-100 p-3 text-sm text-amber-800">
                    <p className="font-medium">Dev mode - OTP (delivered by email in production):</p>
                    <p className="mt-1 font-mono font-bold text-base tracking-wider">{otpMessage}</p>
                  </div>
                ) : (
                  <div className="rounded-lg bg-emerald-50 border border-emerald-100 p-3 text-sm text-emerald-800">
                    A 6-digit code has been sent to the email registered for this order.
                  </div>
                )}
                <div>
                  <label className={labelCls}>Enter 6-digit OTP</label>
                  <input type="text" required maxLength={6} placeholder="123456" className={`${inputCls} font-mono tracking-widest text-center`} value={otpCode} onChange={(e) => setOtpCode(e.target.value)} />
                </div>
                {customerError && <div className="rounded-lg bg-red-50 p-3 text-sm text-red-600">{customerError}</div>}
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
                    <input className={inputCls} value={vendor.contactPhone} onChange={(e) => setVendor({ ...vendor, contactPhone: e.target.value })} />
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
      </div>
    </div>
  );
}
