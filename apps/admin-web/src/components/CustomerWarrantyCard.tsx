"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/apiClient";
import { apiErrorMessage } from "@/lib/apiError";
import { formatDay } from "@/lib/amcUi";
import { warrantyDaysText, warrantyStatusLabel, warrantyStatusPill, type UnitWarranty } from "@/lib/warrantyUi";

interface PortalUnit {
  id: string;
  serialNo: string | null;
  status: string;
  product: { name: string; model: string };
  warranty: UnitWarranty;
}

/**
 * Customer portal: the warranty of the customer's OWN units (read-only). The data comes from GET /recd-units, which the server already
 * limits to the signed-in customer's units; there is no edit control and no history here.
 */
export default function CustomerWarrantyCard() {
  const [units, setUnits] = useState<PortalUnit[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<PortalUnit[]>("/recd-units")
      .then((rows) => { setUnits(rows.filter((u) => u.status === "active")); setError(null); })
      .catch((err) => setError(apiErrorMessage(err, "Could not load your warranty information")));
  }, []);

  return (
    <section className="card p-5" data-testid="customer-warranty">
      <h3 className="text-sm font-semibold">RECD warranty</h3>
      {error && <p role="alert" className="mt-2 text-xs text-red-600">{error}</p>}
      {!error && units === null && <p className="mt-2 text-xs text-gray-400">Loading…</p>}
      {units && units.length === 0 && <p className="mt-2 text-xs text-gray-400">No RECD units are registered for your account yet.</p>}
      {units && units.length > 0 && (
        <ul className="mt-3 divide-y divide-gray-100">
          {units.map((u) => (
            <li key={u.id} className="py-2 text-sm" data-testid={`customer-warranty-${u.serialNo ?? u.id}`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span><span className="font-mono text-xs font-semibold">{u.serialNo ?? "Serial not yet recorded"}</span> <span className="text-xs text-gray-500">{u.product.name} ({u.product.model})</span></span>
                <span className={warrantyStatusPill(u.warranty.status)}>{warrantyStatusLabel(u.warranty.status)}</span>
              </div>
              <div className="mt-0.5 text-xs text-gray-500">
                {u.warranty.startDate && u.warranty.endDate
                  ? `${formatDay(u.warranty.startDate)} to ${formatDay(u.warranty.endDate)} · ${warrantyDaysText(u.warranty)}`
                  : "Warranty dates have not been recorded yet - please contact Platino."}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
