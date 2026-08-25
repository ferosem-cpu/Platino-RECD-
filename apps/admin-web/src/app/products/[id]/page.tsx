"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { api } from "@/lib/apiClient";
import { useAuth } from "@/components/AuthContext";

interface ProductDetail {
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

const SHAPE_LABELS: Record<string, string> = {
  cylinder: "Cylinder",
  triangle: "Triangle",
  rectangle: "Rectangle",
};

export default function ProductDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { hasPermission } = useAuth();
  const canManage = hasPermission("manage_orders");

  const [product, setProduct] = useState<ProductDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(() => {
    if (!id) return;
    setError(null);
    api<ProductDetail>(`/products/${id}`).then(setProduct).catch((e) => setError(e instanceof Error ? e.message : "Failed to load product"));
  }, [id]);

  useEffect(load, [load]);

  async function remove() {
    if (!product) return;
    if (!window.confirm(`Delete product "${product.name}"? This cannot be undone.`)) return;
    setDeleting(true);
    setError(null);
    try {
      await api(`/products/${id}`, { method: "DELETE" });
      router.push("/products");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete product");
      setDeleting(false);
    }
  }

  if (error && !product) return <p className="text-sm text-red-600">{error}</p>;
  if (!product) return <p className="text-sm text-gray-500">Loading...</p>;

  return (
    <div className="space-y-6 max-w-3xl" data-testid="product-detail-page">
      <div className="flex items-start justify-between gap-3">
        <div>
          <Link href="/products" className="text-xs font-medium text-gray-400 hover:text-gray-600">← Products</Link>
          <h1 className="text-xl sm:text-2xl font-semibold" style={{ color: "var(--text-heading)" }}>{product.name}</h1>
          <p className="text-sm text-gray-500 font-mono">{product.model}</p>
        </div>
        {canManage && (
          <div className="flex gap-2 shrink-0">
            <Link
              href={`/products?edit=${product.id}`}
              className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 whitespace-nowrap"
            >
              Edit
            </Link>
            <button
              type="button"
              onClick={remove}
              disabled={deleting}
              className="rounded-lg border border-red-200 px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50 whitespace-nowrap"
            >
              {deleting ? "Deleting…" : "Delete"}
            </button>
          </div>
        )}
      </div>

      {error && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-700">{error}</div>}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <section className="card p-5 space-y-2">
          <h2 className="text-sm font-semibold">Specification</h2>
          {product.ratingSpec && <p className="text-sm text-gray-700">{product.ratingSpec}</p>}
          <div className="data-card-row">
            <span className="label">Capacity</span>
            <span className="value">{product.capacityKva ? `${product.capacityKva} kVA` : "-"}</span>
          </div>
          <div className="data-card-row">
            <span className="label">Warranty</span>
            <span className="value">{product.warrantyMonths != null ? `${product.warrantyMonths} months` : "-"}</span>
          </div>
        </section>

        <section className="card p-5 space-y-2">
          <h2 className="text-sm font-semibold">Structure / scaffold sizing</h2>
          <div className="data-card-row">
            <span className="label">Shape</span>
            <span className="value">{product.shape ? (SHAPE_LABELS[product.shape] ?? product.shape) : "Not set"}</span>
          </div>
          <div className="data-card-row">
            <span className="label">Dimensions</span>
            <span className="value">{product.dimensions ?? "Not set"}</span>
          </div>
          <div className="data-card-row">
            <span className="label">Weight</span>
            <span className="value">{product.weightKg ? `${product.weightKg} kg` : "Not set"}</span>
          </div>
          <div className="data-card-row">
            <span className="label">Silencer Type</span>
            <span className="value">{product.silencerType ?? "Not set"}</span>
          </div>
        </section>
      </div>
    </div>
  );
}
