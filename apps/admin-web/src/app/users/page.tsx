"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/apiClient";

interface UserRow {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  title: string | null;
  role: { key: string; name: string };
  isActive: boolean;
}

interface RoleOption {
  id: string;
  key: string;
  name: string;
}

interface VendorOption {
  id: string;
  name: string;
  status: string;
}

// ── Icons ──────────────────────────────────────────────────────────────

function PencilIcon() {
  return (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10" />
    </svg>
  );
}

function BlockIcon() {
  return (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  );
}

function KeyIcon() {
  return (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 5.25a3 3 0 013 3m3 0a6 6 0 01-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1121.75 8.25z" />
    </svg>
  );
}

export default function UsersPage() {
  const [users, setUsers] = useState<UserRow[]>([]);
  const [roles, setRoles] = useState<RoleOption[]>([]);
  const [vendors, setVendors] = useState<VendorOption[]>([]);
  const [form, setForm] = useState({ name: "", email: "", roleKey: "", phone: "", title: "", vendorId: "" });
  const [tempPassword, setTempPassword] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Edit modal state
  const [editUser, setEditUser] = useState<UserRow | null>(null);
  const [editForm, setEditForm] = useState({ name: "", email: "", roleKey: "", phone: "", title: "" });
  const [editError, setEditError] = useState<string | null>(null);
  const [editLoading, setEditLoading] = useState(false);

  // Deactivate modal state
  const [deactivateUser, setDeactivateUser] = useState<UserRow | null>(null);
  const [deactivateLoading, setDeactivateLoading] = useState(false);

  // Reset password state
  const [resetUser, setResetUser] = useState<UserRow | null>(null);
  const [resetLoading, setResetLoading] = useState(false);
  const [resetResult, setResetResult] = useState<string | null>(null);

  function load() {
    api<UserRow[]>("/users").then(setUsers).catch(() => {});
    api<RoleOption[]>("/meta/roles").then(setRoles).catch(() => {});
    api<VendorOption[]>("/vendors").then(setVendors).catch(() => {});
  }

  useEffect(load, []);

  // ── Create user ────────────────────────────────────────────────────

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setTempPassword(null);
    setSuccess(null);
    try {
      const result = await api<{ tempPassword: string }>("/users", {
        method: "POST",
        body: JSON.stringify({ ...form, vendorId: form.vendorId || undefined }),
      });
      setTempPassword(result.tempPassword);
      setForm({ name: "", email: "", roleKey: "", phone: "", title: "", vendorId: "" });
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add user");
    }
  }

  // ── Edit user ──────────────────────────────────────────────────────

  function openEdit(user: UserRow) {
    setEditUser(user);
    setEditForm({
      name: user.name,
      email: user.email ?? "",
      roleKey: user.role.key,
      phone: user.phone ?? "",
      title: user.title ?? "",
    });
    setEditError(null);
  }

  async function handleEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editUser) return;
    setEditLoading(true);
    setEditError(null);
    try {
      await api(`/users/${editUser.id}`, {
        method: "PUT",
        body: JSON.stringify(editForm),
      });
      setEditUser(null);
      setSuccess("User updated successfully");
      load();
    } catch (err) {
      setEditError(err instanceof Error ? err.message : "Failed to update user");
    } finally {
      setEditLoading(false);
    }
  }

  // ── Deactivate user ────────────────────────────────────────────────

  async function handleDeactivate() {
    if (!deactivateUser) return;
    setDeactivateLoading(true);
    try {
      await api(`/users/${deactivateUser.id}/deactivate`, { method: "PUT" });
      setDeactivateUser(null);
      setSuccess("User deactivated");
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to deactivate user");
      setDeactivateUser(null);
    } finally {
      setDeactivateLoading(false);
    }
  }

  // ── Activate user ──────────────────────────────────────────────────

  async function handleActivate(user: UserRow) {
    setError(null);
    try {
      await api(`/users/${user.id}/activate`, { method: "PUT" });
      setSuccess("User activated");
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to activate user");
    }
  }

  // ── Reset password ─────────────────────────────────────────────────

  async function handleReset() {
    if (!resetUser) return;
    setResetLoading(true);
    try {
      const result = await api<{ tempPassword: string }>(`/users/${resetUser.id}/reset-password`, {
        method: "POST",
      });
      setResetResult(result.tempPassword);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to reset password");
      setResetUser(null);
    } finally {
      setResetLoading(false);
    }
  }

  // ── Dismiss helpers ────────────────────────────────────────────────

  function dismissMessages() {
    setTimeout(() => {
      setSuccess(null);
      setTempPassword(null);
    }, 8000);
  }

  useEffect(() => {
    if (success || tempPassword) dismissMessages();
  }, [success, tempPassword]);

  // ── Render ─────────────────────────────────────────────────────────

  return (
    <div className="space-y-6 max-w-5xl" data-testid="users-page">
      <div>
        <h1 className="text-xl sm:text-2xl font-semibold tracking-tight" style={{ color: "var(--text-heading)" }}>Users</h1>
        <p className="mt-1 text-sm text-gray-500">
          Manage team members and their roles. Add new users, edit details, activate/deactivate accounts, or reset passwords.
        </p>
      </div>

      {/* ── Add user form ─────────────────────────────────────────────── */}
      <form onSubmit={handleSubmit} className="card p-4 sm:p-5" data-testid="add-user-form">
        <h2 className="text-sm font-semibold mb-3">Add new user</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 items-end">
          <div>
            <label className="block text-xs text-gray-500 mb-1">Name</label>
            <input
              required
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--theme-accent)]/30 focus:border-[var(--theme-accent)] transition"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Email</label>
            <input
              required
              type="email"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--theme-accent)]/30 focus:border-[var(--theme-accent)] transition"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Phone</label>
            <input
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--theme-accent)]/30 focus:border-[var(--theme-accent)] transition"
              value={form.phone}
              placeholder="Optional"
              onChange={(e) => setForm({ ...form, phone: e.target.value })}
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Title</label>
            <input
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--theme-accent)]/30 focus:border-[var(--theme-accent)] transition"
              value={form.title}
              placeholder="e.g. Fitter"
              onChange={(e) => setForm({ ...form, title: e.target.value })}
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Role</label>
            <select
              required
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--theme-accent)]/30 focus:border-[var(--theme-accent)] transition"
              value={form.roleKey}
              onChange={(e) => setForm({ ...form, roleKey: e.target.value })}
            >
              <option value="" disabled>Select a role</option>
              {roles.map((r) => (
                <option key={r.key} value={r.key}>{r.name}</option>
              ))}
            </select>
          </div>
          {form.roleKey === "erection_engineer" && (
            <div>
              <label className="block text-xs text-gray-500 mb-1">Vendor</label>
              <select
                required
                className="rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--theme-accent)]/30 focus:border-[var(--theme-accent)] transition"
                value={form.vendorId}
                onChange={(e) => setForm({ ...form, vendorId: e.target.value })}
              >
                <option value="">Select a vendor</option>
                {vendors.filter((v) => v.status === "approved").map((v) => (
                  <option key={v.id} value={v.id}>{v.name}</option>
                ))}
              </select>
            </div>
          )}
          <button
            type="submit"
            className="btn-primary px-4 py-2 text-sm w-full sm:w-auto sm:col-span-2 lg:col-span-1"
            data-testid="add-user-submit"
          >
            Add user
          </button>
        </div>
      </form>

      {/* ── Feedback banners ──────────────────────────────────────────── */}
      {error && (
        <div className="flex items-center gap-2 rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
          <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
          </svg>
          {error}
          <button onClick={() => setError(null)} className="ml-auto text-red-400 hover:text-red-600">✕</button>
        </div>
      )}
      {tempPassword && (
        <div className="flex items-center gap-2 rounded-lg bg-green-50 border border-green-200 px-4 py-3 text-sm text-green-700">
          <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          User created. Temporary password: <code className="rounded bg-green-100 px-2 py-0.5 font-mono font-semibold">{tempPassword}</code>
          <button onClick={() => setTempPassword(null)} className="ml-auto text-green-400 hover:text-green-600">✕</button>
        </div>
      )}
      {success && !tempPassword && (
        <div className="flex items-center gap-2 rounded-lg bg-blue-50 border border-blue-200 px-4 py-3 text-sm text-blue-700">
          <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          {success}
          <button onClick={() => setSuccess(null)} className="ml-auto text-blue-400 hover:text-blue-600">✕</button>
        </div>
      )}

      {/* ── Users table (desktop) ─────────────────────────────────────── */}
      <div className="card overflow-hidden table-desktop">
        <div className="table-scroll">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="bg-gray-50 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">
                <th className="px-5 py-3">Name</th>
                <th className="px-5 py-3">Title</th>
                <th className="px-5 py-3">Email</th>
                <th className="px-5 py-3">Phone</th>
                <th className="px-5 py-3">Role</th>
                <th className="px-5 py-3">Status</th>
                <th className="px-5 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {users.map((u) => (
                <tr key={u.id} className={`hover:bg-gray-50/60 transition-colors ${!u.isActive ? "opacity-60 bg-gray-50/30" : ""}`}>
                  <td className="px-5 py-3 font-medium">{u.name}</td>
                  <td className="px-5 py-3 text-gray-500">{u.title ?? "—"}</td>
                  <td className="px-5 py-3">{u.email ?? "—"}</td>
                  <td className="px-5 py-3 text-gray-500">{u.phone ?? "—"}</td>
                  <td className="px-5 py-3">
                    <span className="inline-flex items-center rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-medium text-gray-700">
                      {u.role.name}
                    </span>
                  </td>
                  <td className="px-5 py-3">
                    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${u.isActive ? "bg-green-100 text-green-800" : "bg-red-100 text-red-800"}`}>
                      {u.isActive ? "Active" : "Inactive"}
                    </span>
                  </td>
                  <td className="px-5 py-3">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        onClick={() => openEdit(u)}
                        className="p-1.5 rounded-lg text-gray-400 hover:text-blue-600 hover:bg-blue-50 transition-colors"
                        title="Edit user"
                      >
                        <PencilIcon />
                      </button>
                      <button
                        onClick={() => { setResetUser(u); setResetResult(null); }}
                        className="p-1.5 rounded-lg text-gray-400 hover:text-amber-600 hover:bg-amber-50 transition-colors"
                        title="Reset password"
                      >
                        <KeyIcon />
                      </button>
                      {u.isActive ? (
                        <button
                          onClick={() => setDeactivateUser(u)}
                          className="p-1.5 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50 transition-colors"
                          title="Deactivate user"
                        >
                          <BlockIcon />
                        </button>
                      ) : (
                        <button
                          onClick={() => handleActivate(u)}
                          className="p-1.5 rounded-lg text-gray-400 hover:text-green-600 hover:bg-green-50 transition-colors"
                          title="Activate user"
                        >
                          <CheckIcon />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {users.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-5 py-8 text-center text-gray-400">
                    No users found
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Users cards (mobile) ──────────────────────────────────────── */}
      <div className="cards-mobile" data-testid="users-mobile-cards">
        {users.length === 0 ? (
          <div className="card p-6 text-center text-sm text-gray-400">No users found</div>
        ) : (
          users.map((u) => (
            <div key={u.id} className={`data-card ${!u.isActive ? "opacity-70" : ""}`} data-testid={`user-card-${u.id}`}>
              <div className="flex items-start justify-between gap-3 mb-2">
                <div className="min-w-0">
                  <p className="font-semibold text-sm text-gray-900 truncate">{u.name}</p>
                  <p className="text-xs text-gray-500 truncate">{u.title ?? "—"}</p>
                </div>
                <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold whitespace-nowrap ${u.isActive ? "bg-green-100 text-green-800" : "bg-red-100 text-red-800"}`}>
                  {u.isActive ? "Active" : "Inactive"}
                </span>
              </div>
              <div className="data-card-row">
                <span className="label">Email</span>
                <span className="value truncate">{u.email ?? "—"}</span>
              </div>
              <div className="data-card-row">
                <span className="label">Phone</span>
                <span className="value">{u.phone ?? "—"}</span>
              </div>
              <div className="data-card-row">
                <span className="label">Role</span>
                <span className="value">
                  <span className="inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-700">
                    {u.role.name}
                  </span>
                </span>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-gray-100 pt-3">
                <button
                  onClick={() => openEdit(u)}
                  className="flex-1 min-w-[40%] rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50 flex items-center justify-center gap-1.5"
                >
                  <PencilIcon /> Edit
                </button>
                <button
                  onClick={() => { setResetUser(u); setResetResult(null); }}
                  className="flex-1 min-w-[40%] rounded-lg border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs font-semibold text-amber-700 hover:bg-amber-100 flex items-center justify-center gap-1.5"
                >
                  <KeyIcon /> Reset
                </button>
                {u.isActive ? (
                  <button
                    onClick={() => setDeactivateUser(u)}
                    className="flex-1 min-w-[40%] rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-100 flex items-center justify-center gap-1.5"
                  >
                    <BlockIcon /> Deactivate
                  </button>
                ) : (
                  <button
                    onClick={() => handleActivate(u)}
                    className="flex-1 min-w-[40%] rounded-lg border border-green-200 bg-green-50 px-3 py-1.5 text-xs font-semibold text-green-700 hover:bg-green-100 flex items-center justify-center gap-1.5"
                  >
                    <CheckIcon /> Activate
                  </button>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      {/* ── Edit Modal ────────────────────────────────────────────────── */}
      {editUser && (
        <div className="modal-backdrop" onClick={() => setEditUser(null)}>
          <div className="modal-panel" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-5">
              <h3 className="text-lg font-semibold">Edit User</h3>
              <button onClick={() => setEditUser(null)} className="text-gray-400 hover:text-gray-600 transition-colors">
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <form onSubmit={handleEdit} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Name</label>
                <input
                  required
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--theme-accent)]/30 focus:border-[var(--theme-accent)] transition"
                  value={editForm.name}
                  onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">Email</label>
                  <input
                    type="email"
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--theme-accent)]/30 focus:border-[var(--theme-accent)] transition"
                    value={editForm.email}
                    onChange={(e) => setEditForm({ ...editForm, email: e.target.value })}
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">Phone</label>
                  <input
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--theme-accent)]/30 focus:border-[var(--theme-accent)] transition"
                    value={editForm.phone}
                    onChange={(e) => setEditForm({ ...editForm, phone: e.target.value })}
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">Title</label>
                  <input
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--theme-accent)]/30 focus:border-[var(--theme-accent)] transition"
                    value={editForm.title}
                    placeholder="e.g. CTO, Fitter"
                    onChange={(e) => setEditForm({ ...editForm, title: e.target.value })}
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">Role</label>
                  <select
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--theme-accent)]/30 focus:border-[var(--theme-accent)] transition"
                    value={editForm.roleKey}
                    onChange={(e) => setEditForm({ ...editForm, roleKey: e.target.value })}
                  >
                    {roles.map((r) => (
                      <option key={r.key} value={r.key}>{r.name}</option>
                    ))}
                  </select>
                </div>
              </div>

              {editError && (
                <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{editError}</p>
              )}

              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setEditUser(null)}
                  className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={editLoading}
                  className="btn-primary px-4 py-2 text-sm"
                >
                  {editLoading ? "Saving…" : "Save changes"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Deactivate Confirmation Modal ─────────────────────────────────── */}
      {deactivateUser && (
        <div className="modal-backdrop" onClick={() => setDeactivateUser(null)}>
          <div className="modal-panel" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start gap-4">
              <div className="flex-shrink-0 w-10 h-10 rounded-full bg-red-100 flex items-center justify-center text-red-600">
                <BlockIcon />
              </div>
              <div className="flex-1">
                <h3 className="text-lg font-semibold">Deactivate User</h3>
                <p className="mt-2 text-sm text-gray-600">
                  Are you sure you want to deactivate <strong>{deactivateUser.name}</strong>?
                  They will not be able to log in to the system.
                </p>
                <div className="flex justify-end gap-3 mt-6">
                  <button
                    onClick={() => setDeactivateUser(null)}
                    className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleDeactivate}
                    disabled={deactivateLoading}
                    className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 transition-colors disabled:opacity-50"
                  >
                    {deactivateLoading ? "Deactivating…" : "Deactivate"}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Reset Password Modal ──────────────────────────────────────── */}
      {resetUser && (
        <div className="modal-backdrop" onClick={() => { setResetUser(null); setResetResult(null); }}>
          <div className="modal-panel" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start gap-4">
              <div className="flex-shrink-0 w-10 h-10 rounded-full bg-amber-100 flex items-center justify-center text-amber-600">
                <KeyIcon />
              </div>
              <div className="flex-1">
                <h3 className="text-lg font-semibold">Reset Password</h3>
                {!resetResult ? (
                  <>
                    <p className="mt-2 text-sm text-gray-600">
                      Generate a new temporary password for <strong>{resetUser.name}</strong>?
                      They will need to use this password to log in.
                    </p>
                    <div className="flex justify-end gap-3 mt-6">
                      <button
                        onClick={() => { setResetUser(null); setResetResult(null); }}
                        className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={handleReset}
                        disabled={resetLoading}
                        className="rounded-lg bg-amber-500 px-4 py-2 text-sm font-medium text-white hover:bg-amber-600 transition-colors disabled:opacity-50"
                      >
                        {resetLoading ? "Generating…" : "Generate password"}
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <p className="mt-2 text-sm text-gray-600">
                      New temporary password for <strong>{resetUser.name}</strong>:
                    </p>
                    <div className="mt-3 flex items-center gap-2 rounded-lg bg-amber-50 border border-amber-200 px-4 py-3">
                      <code className="text-lg font-mono font-bold text-amber-800 tracking-wider">{resetResult}</code>
                      <button
                        onClick={() => navigator.clipboard.writeText(resetResult)}
                        className="ml-auto p-1 rounded text-amber-500 hover:text-amber-700 transition-colors"
                        title="Copy to clipboard"
                      >
                        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M15.666 3.888A2.25 2.25 0 0013.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9.75a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184" />
                        </svg>
                      </button>
                    </div>
                    <p className="mt-2 text-xs text-gray-500">
                      Share this password securely. The user should change it after logging in.
                    </p>
                    <div className="flex justify-end mt-5">
                      <button
                        onClick={() => { setResetUser(null); setResetResult(null); }}
                        className="btn-primary px-4 py-2 text-sm"
                      >
                        Done
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
