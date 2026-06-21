"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/apiClient";

interface UserRow {
  id: string;
  name: string;
  email: string | null;
  title: string | null;
  role: { key: string; name: string };
}

interface RoleOption {
  id: string;
  key: string;
  name: string;
}

export default function UsersPage() {
  const [users, setUsers] = useState<UserRow[]>([]);
  const [roles, setRoles] = useState<RoleOption[]>([]);
  const [form, setForm] = useState({ name: "", email: "", roleKey: "" });
  const [tempPassword, setTempPassword] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function load() {
    api<UserRow[]>("/users").then(setUsers).catch(() => {});
    api<RoleOption[]>("/meta/roles").then(setRoles).catch(() => {});
  }

  useEffect(load, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setTempPassword(null);
    try {
      const result = await api<{ tempPassword: string }>("/users", {
        method: "POST",
        body: JSON.stringify(form),
      });
      setTempPassword(result.tempPassword);
      setForm({ name: "", email: "", roleKey: "" });
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add user");
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Users</h1>
      <p className="text-sm text-gray-500">Owner/Admin adds a person and assigns a role - that role&apos;s permission bundle applies.</p>

      <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-3 rounded-lg border border-gray-200 bg-white p-4">
        <div>
          <label className="block text-xs text-gray-500">Name</label>
          <input
            required
            className="rounded border border-gray-300 px-2 py-1.5 text-sm"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </div>
        <div>
          <label className="block text-xs text-gray-500">Email</label>
          <input
            required
            type="email"
            className="rounded border border-gray-300 px-2 py-1.5 text-sm"
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
          />
        </div>
        <div>
          <label className="block text-xs text-gray-500">Role</label>
          <select
            required
            className="rounded border border-gray-300 px-2 py-1.5 text-sm"
            value={form.roleKey}
            onChange={(e) => setForm({ ...form, roleKey: e.target.value })}
          >
            <option value="" disabled>
              Select a role
            </option>
            {roles.map((r) => (
              <option key={r.key} value={r.key}>
                {r.name}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" className="rounded bg-gray-900 px-3 py-1.5 text-sm font-medium text-white">
          Add user
        </button>
      </form>

      {error && <p className="text-sm text-red-600">{error}</p>}
      {tempPassword && (
        <p className="text-sm text-green-700">
          User created. Temporary password: <code className="rounded bg-green-100 px-1.5 py-0.5">{tempPassword}</code>
        </p>
      )}

      <table className="w-full border-collapse overflow-hidden rounded-lg border border-gray-200 bg-white text-sm">
        <thead className="bg-gray-100 text-left text-gray-600">
          <tr>
            <th className="px-4 py-2">Name</th>
            <th className="px-4 py-2">Title</th>
            <th className="px-4 py-2">Email</th>
            <th className="px-4 py-2">Role</th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id} className="border-t border-gray-100">
              <td className="px-4 py-2">{u.name}</td>
              <td className="px-4 py-2 text-gray-500">{u.title ?? "-"}</td>
              <td className="px-4 py-2">{u.email}</td>
              <td className="px-4 py-2">{u.role.name}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
