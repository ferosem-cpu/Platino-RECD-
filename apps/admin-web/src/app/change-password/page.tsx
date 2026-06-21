"use client";

import { useState } from "react";
import { useAuth } from "@/components/AuthContext";
import { api } from "@/lib/apiClient";

export default function ChangePasswordPage() {
  const { refresh, logout } = useAuth();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (newPassword !== confirmPassword) {
      setError("New passwords do not match");
      return;
    }

    if (newPassword.length < 6) {
      setError("New password must be at least 6 characters long");
      return;
    }

    setLoading(true);
    try {
      await api("/auth/change-password", {
        method: "POST",
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      setSuccess(true);
      setTimeout(async () => {
        await refresh();
      }, 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to change password");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 p-4">
      <div className="w-full max-w-md space-y-4 rounded-2xl border border-gray-200 bg-white p-8 shadow-xl">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-gray-900">Change Password</h1>
          <p className="mt-2 text-sm text-gray-500">
            For security reasons, you must change your password before continuing.
          </p>
        </div>

        {success ? (
          <div className="rounded-lg bg-green-50 p-4 text-center text-sm font-medium text-green-800">
            Password changed successfully! Redirecting you...
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-gray-500 mb-1">
                Current Password
              </label>
              <input
                type="password"
                required
                className="w-full rounded-xl border border-gray-300 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--theme-accent)]/30 focus:border-[var(--theme-accent)] transition"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
              />
            </div>

            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-gray-500 mb-1">
                New Password
              </label>
              <input
                type="password"
                required
                className="w-full rounded-xl border border-gray-300 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--theme-accent)]/30 focus:border-[var(--theme-accent)] transition"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
              />
            </div>

            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-gray-500 mb-1">
                Confirm New Password
              </label>
              <input
                type="password"
                required
                className="w-full rounded-xl border border-gray-300 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--theme-accent)]/30 focus:border-[var(--theme-accent)] transition"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
              />
            </div>

            {error && (
              <div className="rounded-lg bg-red-50 p-3 text-sm text-red-600">
                {error}
              </div>
            )}

            <div className="flex flex-col space-y-2 pt-2">
              <button
                type="submit"
                disabled={loading}
                className="btn-primary w-full py-2.5 text-sm font-semibold flex justify-center items-center"
              >
                {loading ? "Updating..." : "Update Password"}
              </button>
              
              <button
                type="button"
                onClick={logout}
                className="w-full text-xs text-gray-500 hover:text-gray-700 py-1.5 transition-colors"
              >
                Cancel & Sign Out
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
