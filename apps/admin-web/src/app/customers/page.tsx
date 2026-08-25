"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { api } from "@/lib/apiClient";
import { useAuth } from "@/components/AuthContext";
import { DataTable, DataTableColumn } from "@/components/DataTable";

interface Customer {
  id: string;
  name: string;
  address: string | null;
  contacts: { id: string; name: string; phone: string | null; email: string | null }[];
}

export default function CustomersPage() {
  return (
    <Suspense fallback={null}>
      <CustomersPageInner />
    </Suspense>
  );
}

function CustomersPageInner() {
  const { hasPermission } = useAuth();
  const canManage = hasPermission("manage_orders");
  const searchParams = useSearchParams();
  const editCustomerId = searchParams.get("edit");

  const [customers, setCustomers] = useState<Customer[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Customer | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: "",
    address: "",
    contactName: "",
    contactPhone: "",
    contactEmail: "",
  });
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  function load() {
    api<Customer[]>("/customers")
      .then(setCustomers)
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load customers"));
  }

  useEffect(load, []);

  // Arriving from a customer detail page's "Edit" link - open that customer's edit modal
  // directly instead of making the user find and click Edit again from the list. Guarded by
  // a ref (not just the effect deps) because saving reloads `customers`, which would otherwise
  // re-trigger this effect while `?edit=` is still in the URL and pop the modal back open
  // right after it closes.
  const appliedEditId = useRef<string | null>(null);
  useEffect(() => {
    if (editCustomerId && editCustomerId !== appliedEditId.current && customers.length > 0) {
      const match = customers.find((c) => c.id === editCustomerId);
      if (match) {
        appliedEditId.current = editCustomerId;
        openEdit(match);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editCustomerId, customers]);

  function openCreate() {
    setEditing(null);
    setForm({ name: "", address: "", contactName: "", contactPhone: "", contactEmail: "" });
    setFormError(null);
    setOpen(true);
  }

  function openEdit(c: Customer) {
    const contact = c.contacts[0];
    setEditing(c);
    setForm({
      name: c.name,
      address: c.address ?? "",
      contactName: contact?.name ?? "",
      contactPhone: contact?.phone ?? "",
      contactEmail: contact?.email ?? "",
    });
    setFormError(null);
    setOpen(true);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setFormError(null);
    try {
      if (editing) {
        await api(`/customers/${editing.id}`, {
          method: "PUT",
          body: JSON.stringify({
            name: form.name,
            address: form.address || undefined,
            contactName: form.contactName || undefined,
            contactPhone: form.contactPhone || undefined,
            contactEmail: form.contactEmail || undefined,
          }),
        });
      } else {
        await api("/customers", {
          method: "POST",
          body: JSON.stringify({
            name: form.name,
            address: form.address || undefined,
            contactName: form.contactName,
            contactPhone: form.contactPhone,
            contactEmail: form.contactEmail || undefined,
          }),
        });
      }
      setOpen(false);
      setEditing(null);
      setForm({ name: "", address: "", contactName: "", contactPhone: "", contactEmail: "" });
      load();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Failed to save customer");
    } finally {
      setSaving(false);
    }
  }

  async function remove(c: Customer) {
    if (!confirm(`Delete customer "${c.name}"? This cannot be undone.`)) return;
    setDeletingId(c.id);
    setDeleteError(null);
    try {
      await api(`/customers/${c.id}`, { method: "DELETE" });
      load();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Failed to delete customer");
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="space-y-6 max-w-5xl" data-testid="customers-page">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 print:hidden">
        <div>
          <h1 className="text-xl sm:text-2xl font-semibold tracking-tight" style={{ color: "var(--text-heading)" }}>Customers</h1>
          <p className="mt-1 text-sm text-gray-500">Companies we're contracted with. Each can have multiple orders and sites.</p>
        </div>
        {canManage && (
          <button
            data-testid="customers-new-button"
            onClick={openCreate}
            className="btn-primary px-4 py-2 text-sm self-start sm:self-auto"
          >
            + New customer
          </button>
        )}
      </div>

      {error && <p className="text-sm text-red-600 print:hidden">{error}</p>}
      {deleteError && <p className="text-sm text-red-600">{deleteError}</p>}

      <DataTable
        storageKey="customers"
        title="Customers"
        rows={customers}
        rowKey={(c) => c.id}
        emptyMessage="No customers yet."
        columns={[
          {
            key: "name",
            label: "Name",
            accessor: (c) => c.name,
            alwaysVisible: true,
            filterType: "text",
            render: (c) => (
              <Link href={`/customers/${c.id}`} className="hover:underline" style={{ color: "var(--theme-primary)" }}>
                {c.name}
              </Link>
            ),
          },
          { key: "address", label: "Address", accessor: (c) => c.address ?? "", filterType: "text" },
          {
            key: "contact",
            label: "Primary contact",
            filterType: "text",
            accessor: (c) => {
              const contact = c.contacts[0];
              return contact ? `${contact.name}${contact.phone ? ` ${contact.phone}` : ""}` : "";
            },
            render: (c) => {
              const contact = c.contacts[0];
              return contact ? (
                <>
                  {contact.name}
                  {contact.phone && <> · {contact.phone}</>}
                </>
              ) : (
                "-"
              );
            },
          },
          ...(canManage
            ? [
                {
                  key: "actions",
                  label: "Actions",
                  align: "right" as const,
                  alwaysVisible: true,
                  filterable: false,
                  render: (c: Customer) => (
                    <>
                      <button onClick={() => openEdit(c)} className="text-sm font-medium text-blue-600 hover:text-blue-800 mr-3">
                        Edit
                      </button>
                      <button
                        onClick={() => remove(c)}
                        disabled={deletingId === c.id}
                        className="text-sm font-medium text-red-600 hover:text-red-800 disabled:opacity-50"
                      >
                        {deletingId === c.id ? "Deleting…" : "Delete"}
                      </button>
                    </>
                  ),
                },
              ]
            : []),
        ]}
      >
        {(filteredCustomers) => (
          <div className="cards-mobile" data-testid="customers-mobile-cards">
            {filteredCustomers.length === 0 ? (
              <div className="card p-6 text-center text-sm text-gray-400">
                {customers.length === 0 ? "No customers yet." : "No rows match the current filters."}
              </div>
            ) : (
              filteredCustomers.map((c) => {
                const contact = c.contacts[0];
                return (
                  <div key={c.id} className="data-card">
                    <Link href={`/customers/${c.id}`} className="text-sm font-semibold text-gray-900 truncate block hover:underline">
                      {c.name}
                    </Link>
                    <p className="text-xs text-gray-500 mb-2 truncate">{c.address ?? "No address on file"}</p>
                    {contact && (
                      <div className="data-card-row">
                        <span className="label">Contact</span>
                        <span className="value">{contact.name}{contact.phone && ` · ${contact.phone}`}</span>
                      </div>
                    )}
                    {canManage && (
                      <div className="mt-3 flex justify-end gap-4">
                        <button onClick={() => openEdit(c)} className="text-sm font-medium text-blue-600">Edit</button>
                        <button
                          onClick={() => remove(c)}
                          disabled={deletingId === c.id}
                          className="text-sm font-medium text-red-600 disabled:opacity-50"
                        >
                          {deletingId === c.id ? "Deleting…" : "Delete"}
                        </button>
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        )}
      </DataTable>

      {open && (
        <div className="modal-backdrop" onClick={() => setOpen(false)}>
          <div className="modal-panel" onClick={(e) => e.stopPropagation()}>
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-lg font-semibold">{editing ? "Edit customer" : "New customer"}</h3>
              <button onClick={() => setOpen(false)} className="text-gray-400 hover:text-gray-600">✕</button>
            </div>
            <form onSubmit={submit} className="space-y-3">
              <input required placeholder="Company name" className="field w-full" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              <textarea placeholder="Address (optional)" rows={2} className="field w-full" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <input required placeholder="Contact name" className="field" value={form.contactName} onChange={(e) => setForm({ ...form, contactName: e.target.value })} />
                <input required placeholder="Contact phone (login)" className="field" value={form.contactPhone} onChange={(e) => setForm({ ...form, contactPhone: e.target.value })} />
              </div>
              <input type="email" placeholder="Contact email (optional)" className="field w-full" value={form.contactEmail} onChange={(e) => setForm({ ...form, contactEmail: e.target.value })} />
              <p className="text-[11px] text-gray-400">The phone number is what the customer uses to log in with their Order ID.</p>

              {formError && <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{formError}</p>}

              <div className="flex justify-end gap-3 pt-1">
                <button type="button" onClick={() => setOpen(false)} className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors">Cancel</button>
                <button type="submit" disabled={saving} className="btn-primary px-4 py-2 text-sm">
                  {saving ? (editing ? "Saving…" : "Creating…") : editing ? "Save changes" : "Create customer"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
