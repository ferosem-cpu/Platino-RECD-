"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/apiClient";

interface OrderRow {
  id: string;
  orderNumber: string;
  value: string;
  customer: { name: string };
  product: { name: string; model: string };
  site: { currentStage: { label: string } } | null;
}

export default function OrdersPage() {
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<OrderRow[]>("/orders")
      .then(setOrders)
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load orders"));
  }, []);

  return (
    <div>
      <h1 className="mb-4 text-xl font-semibold">Orders</h1>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <table className="w-full border-collapse overflow-hidden rounded-lg border border-gray-200 bg-white text-sm">
        <thead className="bg-gray-100 text-left text-gray-600">
          <tr>
            <th className="px-4 py-2">Order #</th>
            <th className="px-4 py-2">Customer</th>
            <th className="px-4 py-2">Product</th>
            <th className="px-4 py-2">Value</th>
            <th className="px-4 py-2">Current stage</th>
          </tr>
        </thead>
        <tbody>
          {orders.map((o) => (
            <tr key={o.id} className="border-t border-gray-100">
              <td className="px-4 py-2 font-medium">{o.orderNumber}</td>
              <td className="px-4 py-2">{o.customer.name}</td>
              <td className="px-4 py-2">{o.product.name} ({o.product.model})</td>
              <td className="px-4 py-2">₹{Number(o.value).toLocaleString("en-IN")}</td>
              <td className="px-4 py-2">{o.site?.currentStage.label ?? "-"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
