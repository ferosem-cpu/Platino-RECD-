"use client";

import { useState } from "react";
import { useAuth } from "@/components/AuthContext";
import { api } from "@/lib/apiClient";

export default function LoginPage() {
  const { login } = useAuth();
  const [activeTab, setActiveTab] = useState<"staff" | "customer">("staff");

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
      const result = await api<{ ok: boolean; message: string; code?: string }>("/auth/customer/register", {
        method: "POST",
        body: JSON.stringify({ orderNumber, phone }),
      });
      setOtpSent(true);
      // For testing convenience, display the generated code in a developer banner
      if (result.code) {
        setOtpMessage(`OTP generated: ${result.code}`);
      } else {
        setOtpMessage("OTP sent to your registered contact number");
      }
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

  return (
    <div className="flex min-h-[90vh] items-center justify-center p-4">
      <div className="w-full max-w-md rounded-2xl border border-gray-200 bg-white p-8 shadow-xl">
        <div className="text-center mb-6">
          <h1 className="text-2xl font-bold tracking-tight text-gray-900">RECD Tracker</h1>
          <p className="mt-2 text-sm text-gray-500">Project & Service Management System</p>
        </div>

        {/* Tab Headers */}
        <div className="flex border-b border-gray-100 mb-6">
          <button
            onClick={() => {
              setActiveTab("staff");
              setCustomerError(null);
              setStaffError(null);
            }}
            className={`flex-1 pb-3 text-sm font-semibold border-b-2 transition-colors ${
              activeTab === "staff"
                ? "border-[var(--theme-accent)] text-gray-900"
                : "border-transparent text-gray-400 hover:text-gray-600"
            }`}
          >
            Staff Login
          </button>
          <button
            onClick={() => {
              setActiveTab("customer");
              setCustomerError(null);
              setStaffError(null);
            }}
            className={`flex-1 pb-3 text-sm font-semibold border-b-2 transition-colors ${
              activeTab === "customer"
                ? "border-[var(--theme-accent)] text-gray-900"
                : "border-transparent text-gray-400 hover:text-gray-600"
            }`}
          >
            Track My Order
          </button>
        </div>

        {/* Staff Sign In Tab */}
        {activeTab === "staff" && (
          <form onSubmit={handleStaffSubmit} className="space-y-4">
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-gray-500 mb-1">Email</label>
              <input
                type="email"
                required
                className="w-full rounded-xl border border-gray-300 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--theme-accent)]/30 focus:border-[var(--theme-accent)] transition"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-gray-500 mb-1">Password</label>
              <input
                type="password"
                required
                className="w-full rounded-xl border border-gray-300 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--theme-accent)]/30 focus:border-[var(--theme-accent)] transition"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            {staffError && (
              <div className="rounded-lg bg-red-50 p-3 text-sm text-red-600">
                {staffError}
              </div>
            )}
            <button
              type="submit"
              disabled={staffLoading}
              className="btn-primary w-full py-2.5 text-sm font-semibold disabled:opacity-50"
            >
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
                  <label className="block text-xs font-semibold uppercase tracking-wider text-gray-500 mb-1">Order ID</label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. ORD-2026-0001"
                    className="w-full rounded-xl border border-gray-300 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--theme-accent)]/30 focus:border-[var(--theme-accent)] transition"
                    value={orderNumber}
                    onChange={(e) => setOrderNumber(e.target.value)}
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider text-gray-500 mb-1">Phone Number</label>
                  <input
                    type="tel"
                    required
                    placeholder="e.g. +919900011122"
                    className="w-full rounded-xl border border-gray-300 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--theme-accent)]/30 focus:border-[var(--theme-accent)] transition"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                  />
                </div>
                {customerError && (
                  <div className="rounded-lg bg-red-50 p-3 text-sm text-red-600">
                    {customerError}
                  </div>
                )}
                <button
                  type="submit"
                  disabled={customerLoading}
                  className="btn-primary w-full py-2.5 text-sm font-semibold disabled:opacity-50"
                >
                  {customerLoading ? "Sending OTP..." : "Get One-Time Password"}
                </button>
              </form>
            ) : (
              <form onSubmit={handleCustomerVerifyOtp} className="space-y-4">
                <div className="rounded-lg bg-emerald-50 border border-emerald-100 p-3 text-sm text-emerald-800">
                  <p className="font-medium">OTP Code generated for testing:</p>
                  <p className="mt-1 font-mono font-bold text-base tracking-wider">{otpMessage}</p>
                </div>
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider text-gray-500 mb-1">Enter 6-digit OTP</label>
                  <input
                    type="text"
                    required
                    maxLength={6}
                    placeholder="123456"
                    className="w-full rounded-xl border border-gray-300 px-3 py-2.5 text-sm font-mono tracking-widest text-center focus:outline-none focus:ring-2 focus:ring-[var(--theme-accent)]/30 focus:border-[var(--theme-accent)] transition"
                    value={otpCode}
                    onChange={(e) => setOtpCode(e.target.value)}
                  />
                </div>
                {customerError && (
                  <div className="rounded-lg bg-red-50 p-3 text-sm text-red-600">
                    {customerError}
                  </div>
                )}
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setOtpSent(false);
                      setOtpCode("");
                    }}
                    className="flex-1 rounded-xl border border-gray-300 px-3 py-2.5 text-sm font-semibold text-gray-700 hover:bg-gray-50 transition-colors"
                  >
                    Back
                  </button>
                  <button
                    type="submit"
                    disabled={customerLoading}
                    className="flex-[2] btn-primary py-2.5 text-sm font-semibold disabled:opacity-50"
                  >
                    {customerLoading ? "Verifying..." : "Verify & Track Order"}
                  </button>
                </div>
              </form>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
