"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { api } from "@/lib/apiClient";
import { useAuth } from "@/components/AuthContext";
import { DataTable } from "@/components/DataTable";

interface Product {
  id: string;
  name: string;
  model: string;
  ratingSpec: string | null;
  capacityKva: string | null;
  warrantyMonths: number | null;
  shape: string | null;
  dimensions: string | null;
  weightKg: string | null;
  silencerType: number | null;
}

const SHAPE_OPTIONS = [
  { value: "", label: "Not set" },
  { value: "cylinder", label: "Cylinder" },
  { value: "triangle", label: "Triangle" },
  { value: "rectangle", label: "Rectangle" },
];

const SILENCER_TYPE_OPTIONS = [
  { value: "", label: "Not set" },
  { value: "1", label: "1" },
  { value: "2", label: "2" },
];

const emptyForm = {
  name: "",
  model: "",
  ratingSpec: "",
  capacityKva: "",
  warrantyMonths: "",
  shape: "",
  dimensions: "",
  weightKg: "",
  silencerType: "",
};

export default function ProductsPage() {
  return (
    <Suspense fallback={null}>
      <ProductsPageInner />
    </Suspense>
  );
}

function ProductsPageInner() {
  const { hasPermission } = useAuth();
  const canManage = hasPermission("manage_orders");
  const searchParams = useSearchParams();
  const editProductId = searchParams.get("edit");

  const [products, setProducts] = useState<Product[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Product | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  function load() {
    api<Product[]>("/products")
      .then(setProducts)
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load products"));
  }

  useEffect(load, []);

  // Arriving from a product detail page's "Edit" link - open that product's edit modal
  // directly instead of making the user find and click Edit again from the list. Guarded by
  // a ref (not just the effect deps) because saving reloads `products`, which would otherwise
  // re-trigger this effect while `?edit=` is still in the URL and pop the modal back open
  // right after it closes.
  const appliedEditId = useRef<string | null>(null);
  useEffect(() => {
    if (editProductId && editProductId !== appliedEditId.current && products.length > 0) {
      const match = products.find((p) => p.id === editProductId);
      if (match) {
        appliedEditId.current = editProductId;
        openEdit(match);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editProductId, products]);

  function openCreate() {
    setEditing(null);
    setForm(emptyForm);
    setFormError(null);
    setOpen(true);
  }

  function openEdit(p: Product) {
    setEditing(p);
    setForm({
      name: p.name,
      model: p.model,
      ratingSpec: p.ratingSpec ?? "",
      capacityKva: p.capacityKva ?? "",
      warrantyMonths: p.warrantyMonths != null ? String(p.warrantyMonths) : "",
      shape: p.shape ?? "",
      dimensions: p.dimensions ?? "",
      weightKg: p.weightKg ?? "",
      silencerType: p.silencerType != null ? String(p.silencerType) : "",
    });
    setFormError(null);
    setOpen(true);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setFormError(null);
    try {
      const body = {
        name: form.name,
        model: form.model,
        ratingSpec: form.ratingSpec || undefined,
        capacityKva: form.capacityKva ? parseFloat(form.capacityKva) : undefined,
        warrantyMonths: form.warrantyMonths ? parseInt(form.warrantyMonths, 10) : undefined,
        shape: form.shape || undefined,
        dimensions: form.dimensions || undefined,
        weightKg: form.weightKg ? parseFloat(form.weightKg) : undefined,
        silencerType: form.silencerType ? (parseInt(form.silencerType, 10) as 1 | 2) : undefined,
      };
      if (editing) {
        await api(`/products/${editing.id}`, { method: "PUT", body: JSON.stringify(body) });
      } else {
        await api("/products", { method: "POST", body: JSON.stringify(body) });
      }
      setOpen(false);
      setEditing(null);
      setForm(emptyForm);
      load();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Failed to save product");
    } finally {
      setSaving(false);
    }
  }

  async function remove(p: Product) {
    if (!confirm(`Delete product "${p.name}"? This cannot be undone.`)) return;
    setDeletingId(p.id);
    setDeleteError(null);
    try {
      await api(`/products/${p.id}`, { method: "DELETE" });
      load();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Failed to delete product");
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="space-y-6 max-w-5xl" data-testid="products-page">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 print:hidden">
        <div>
          <h1 className="text-xl sm:text-2xl font-semibold tracking-tight" style={{ color: "var(--text-heading)" }}>Products</h1>
          <p className="mt-1 text-sm text-gray-500">RECD models used across orders and sites.</p>
        </div>
        {canManage && (
          <button
            data-testid="products-new-button"
            onClick={openCreate}
            className="btn-primary px-4 py-2 text-sm self-start sm:self-auto"
          >
            + New product
          </button>
        )}
      </div>

      {error && <p className="text-sm text-red-600 print:hidden">{error}</p>}
      {deleteError && <p className="text-sm text-red-600">{deleteError}</p>}

      <DataTable
        storageKey="products"
        title="Products"
        rows={products}
        rowKey={(p) => p.id}
        emptyMessage="No products yet."
        columns={[
          {
            key: "name",
            label: "Name",
            accessor: (p) => p.name,
            alwaysVisible: true,
            filterType: "text",
            render: (p) => (
              <Link href={`/products/${p.id}`} className="hover:underline" style={{ color: "var(--theme-primary)" }}>
                {p.name}
              </Link>
            ),
          },
          {
            key: "model",
            label: "Model",
            accessor: (p) => p.model,
            filterType: "text",
            render: (p) => <span className="font-mono text-xs">{p.model}</span>,
          },
          { key: "ratingSpec", label: "Rating spec", accessor: (p) => p.ratingSpec ?? "" },
          { key: "capacityKva", label: "Capacity (kVA)", accessor: (p) => p.capacityKva ?? "" },
          { key: "warrantyMonths", label: "Warranty (months)", accessor: (p) => p.warrantyMonths ?? "" },
          { key: "shape", label: "Shape", accessor: (p) => p.shape ?? "", defaultVisible: false },
          { key: "dimensions", label: "Dimensions", accessor: (p) => p.dimensions ?? "", defaultVisible: false, filterType: "text" },
          { key: "weightKg", label: "Weight (kg)", accessor: (p) => p.weightKg ?? "", defaultVisible: false },
          { key: "silencerType", label: "Silencer Type", accessor: (p) => p.silencerType ?? "", defaultVisible: false },
          ...(canManage
            ? [
                {
                  key: "actions",
                  label: "Actions",
                  align: "right" as const,
                  alwaysVisible: true,
                  filterable: false,
                  render: (p: Product) => (
                    <>
                      <button onClick={() => openEdit(p)} className="text-sm font-medium text-blue-600 hover:text-blue-800 mr-3">
                        Edit
                      </button>
                      <button
                        onClick={() => remove(p)}
                        disabled={deletingId === p.id}
                        className="text-sm font-medium text-red-600 hover:text-red-800 disabled:opacity-50"
                      >
                        {deletingId === p.id ? "Deleting…" : "Delete"}
                      </button>
                    </>
                  ),
                },
              ]
            : []),
        ]}
      >
        {(filteredProducts) => (
          <div className="cards-mobile" data-testid="products-mobile-cards">
            {filteredProducts.length === 0 ? (
              <div className="card p-6 text-center text-sm text-gray-400">
                {products.length === 0 ? "No products yet." : "No rows match the current filters."}
              </div>
            ) : (
              filteredProducts.map((p) => (
                <div key={p.id} className="data-card">
                  <Link href={`/products/${p.id}`} className="text-sm font-semibold text-gray-900 truncate block hover:underline">
                    {p.name}
                  </Link>
                  <p className="text-xs text-gray-500 mb-2 font-mono">{p.model}</p>
                  {p.ratingSpec && (
                    <div className="data-card-row">
                      <span className="label">Rating spec</span>
                      <span className="value">{p.ratingSpec}</span>
                    </div>
                  )}
                  {p.capacityKva && (
                    <div className="data-card-row">
                      <span className="label">Capacity</span>
                      <span className="value">{p.capacityKva} kVA</span>
                    </div>
                  )}
                  {p.warrantyMonths != null && (
                    <div className="data-card-row">
                      <span className="label">Warranty</span>
                      <span className="value">{p.warrantyMonths} months</span>
                    </div>
                  )}
                  {canManage && (
                    <div className="mt-3 flex justify-end gap-4">
                      <button onClick={() => openEdit(p)} className="text-sm font-medium text-blue-600">Edit</button>
                      <button
                        onClick={() => remove(p)}
                        disabled={deletingId === p.id}
                        className="text-sm font-medium text-red-600 disabled:opacity-50"
                      >
                        {deletingId === p.id ? "Deleting…" : "Delete"}
                      </button>
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        )}
      </DataTable>

      {open && (
        <div className="modal-backdrop" onClick={() => setOpen(false)}>
          <div className="modal-panel" onClick={(e) => e.stopPropagation()}>
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-lg font-semibold">{editing ? "Edit product" : "New product"}</h3>
              <button onClick={() => setOpen(false)} className="text-gray-400 hover:text-gray-600">✕</button>
            </div>
            <form onSubmit={submit} className="space-y-3">
              <input required placeholder="Product name" className="field w-full" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              <input required placeholder="Model (unique)" className="field w-full" value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} />
              <input placeholder="Rating spec (optional)" className="field w-full" value={form.ratingSpec} onChange={(e) => setForm({ ...form, ratingSpec: e.target.value })} />
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <input type="number" min={0} step="0.01" placeholder="Capacity (kVA)" className="field" value={form.capacityKva} onChange={(e) => setForm({ ...form, capacityKva: e.target.value })} />
                <input type="number" min={0} placeholder="Warranty (months)" className="field" value={form.warrantyMonths} onChange={(e) => setForm({ ...form, warrantyMonths: e.target.value })} />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <select className="field" value={form.shape} onChange={(e) => setForm({ ...form, shape: e.target.value })}>
                  {SHAPE_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
                <input type="number" min={0} step="0.01" placeholder="Weight (kg)" className="field" value={form.weightKg} onChange={(e) => setForm({ ...form, weightKg: e.target.value })} />
              </div>
              <input placeholder="Dimensions (e.g. 1200 x 600 x 900 mm)" className="field w-full" value={form.dimensions} onChange={(e) => setForm({ ...form, dimensions: e.target.value })} />
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Silencer Type</label>
                <select className="field w-full" value={form.silencerType} onChange={(e) => setForm({ ...form, silencerType: e.target.value })}>
                  {SILENCER_TYPE_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </div>

              {formError && <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{formError}</p>}

              <div className="flex justify-end gap-3 pt-1">
                <button type="button" onClick={() => setOpen(false)} className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors">Cancel</button>
                <button type="submit" disabled={saving} className="btn-primary px-4 py-2 text-sm">
                  {saving ? (editing ? "Saving…" : "Creating…") : editing ? "Save changes" : "Create product"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
