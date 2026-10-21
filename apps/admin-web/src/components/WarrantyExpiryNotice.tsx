"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/apiClient";
import { formatDay, unseenAlerts } from "@/lib/amcUi";
import { WARRANTY_NOTICE_STORAGE_KEY, warrantyDaysText, warrantyStatusLabel } from "@/lib/warrantyUi";

interface Alert {
  key: string;
  unitId: string;
  serialNo: string | null;
  productName: string;
  customerName: string;
  siteName: string | null;
  endDate: string;
  status: "expiring_soon" | "expired";
  daysRemaining: number | null;
  daysSinceExpiry: number | null;
}

function readSeen(): string[] {
  try {
    const raw = window.sessionStorage.getItem(WARRANTY_NOTICE_STORAGE_KEY);
    const v = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function writeSeen(keys: string[]) {
  try {
    window.sessionStorage.setItem(WARRANTY_NOTICE_STORAGE_KEY, JSON.stringify(keys));
  } catch {
    // storage blocked: the notice may show again after a reload, which is harmless
  }
}

/**
 * Login-time warranty notice (Requirement 8), the sibling of the AMC notice: one dialog listing the units the signed-in user may see whose
 * warranty is expiring soon or recently expired. The server decides what (GET /warranty-alerts); a dismissed alert is not shown again in
 * this browser session unless its expiry date or status changed. It waits while the AMC notice is open so the two never stack, and a
 * failure never gets in the way of signing in. `unitHref` is where a row links to (the customer portal has no unit page).
 */
export default function WarrantyExpiryNotice({ userId, linkToUnits }: { userId: string; linkToUnits: boolean }) {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [blocked, setBlocked] = useState(false);

  useEffect(() => {
    let live = true;
    api<{ alerts: Alert[]; truncated: boolean }>("/warranty-alerts")
      .then((d) => {
        if (!live) return;
        setAlerts(unseenAlerts(d.alerts, readSeen()));
        setTruncated(d.truncated);
      })
      .catch(() => {});
    return () => { live = false; };
  }, [userId]);

  // Wait while the AMC notice is on screen.
  useEffect(() => {
    if (alerts.length === 0) return;
    const check = () => setBlocked(!!document.querySelector("[data-testid=amc-expiry-notice]"));
    check();
    const t = window.setInterval(check, 400);
    return () => window.clearInterval(t);
  }, [alerts.length]);

  if (alerts.length === 0 || blocked) return null;

  function dismiss() {
    writeSeen([...new Set([...readSeen(), ...alerts.map((a) => a.key)])]);
    setAlerts([]);
  }

  return (
    <div className="modal-backdrop" onClick={dismiss}>
      <div className="modal-panel" role="dialog" aria-label="RECD warranties needing attention" data-testid="warranty-expiry-notice" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-lg font-semibold">RECD warranties needing attention</h3>
          <button onClick={dismiss} aria-label="Close" className="text-gray-400 hover:text-gray-600">✕</button>
        </div>
        <ul className="space-y-2 max-h-80 overflow-y-auto" data-testid="warranty-expiry-notice-list">
          {alerts.map((a) => (
            <li key={a.key} className="rounded-lg border border-gray-200 p-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium">
                  {linkToUnits ? (
                    <Link href={`/recd-units/${a.unitId}`} onClick={dismiss} className="font-mono text-xs hover:underline">{a.serialNo ?? "Serial not recorded"}</Link>
                  ) : (
                    <span className="font-mono text-xs">{a.serialNo ?? "Serial not recorded"}</span>
                  )}{" "}
                  <span className="text-gray-500">{a.productName}</span>
                </span>
                <span className={a.status === "expired" ? "status-pill status-pill-error" : "status-pill status-pill-warning"}>{warrantyStatusLabel(a.status)}</span>
              </div>
              <div className="mt-1 text-xs text-gray-600">
                {a.customerName}{a.siteName ? ` · ${a.siteName}` : ""} · expiry {formatDay(a.endDate)} · {warrantyDaysText({ status: a.status, daysRemaining: a.daysRemaining, daysUntilStart: null, daysSinceExpiry: a.daysSinceExpiry })}
              </div>
            </li>
          ))}
        </ul>
        {truncated && <p className="mt-2 text-xs text-gray-500">More warranties need attention than are listed here.</p>}
        <div className="mt-4 flex justify-end gap-3">
          <button onClick={dismiss} className="btn-primary px-4 py-2 text-sm" data-testid="warranty-notice-dismiss">Dismiss</button>
        </div>
      </div>
    </div>
  );
}
