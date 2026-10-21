"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/apiClient";
import { AMC_TYPE_LABELS } from "@recd/shared";
import { AMC_NOTICE_STORAGE_KEY, contractStatusLabel, daysText, formatDay, unseenAlerts } from "@/lib/amcUi";

interface Alert {
  key: string;
  kind: "customer" | "vendor";
  id: string;
  ref: string;
  partyName: string;
  customerName?: string | null;
  siteName?: string | null;
  /** CAMC / NAMC for a customer contract (null for a vendor contract). */
  amcType?: string | null;
  startDate: string;
  endDate: string;
  status: "expiring_soon" | "expired";
  daysRemaining: number;
}

function readSeen(): string[] {
  try {
    const raw = window.sessionStorage.getItem(AMC_NOTICE_STORAGE_KEY);
    const v = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function writeSeen(keys: string[]) {
  try {
    window.sessionStorage.setItem(AMC_NOTICE_STORAGE_KEY, JSON.stringify(keys));
  } catch {
    // storage blocked: the notice may then show again after a reload, which is harmless
  }
}

/**
 * Login-time notice (Requirement 7): one dialog listing the AMC contracts the signed-in user may see that are expiring soon or
 * expired. Which ones is decided by the server (GET /amc-alerts). Once dismissed, the same contract at the same end date and
 * status is not shown again in this browser session; a renewal (new end date) or a status change is new again.
 */
export default function AmcExpiryNotice({ userId, canOpenAmc }: { userId: string; canOpenAmc: boolean }) {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [truncated, setTruncated] = useState(false);

  useEffect(() => {
    let live = true;
    api<{ alerts: Alert[]; truncated: boolean }>("/amc-alerts")
      .then((d) => {
        if (!live) return;
        const fresh = unseenAlerts(d.alerts, readSeen());
        setAlerts(fresh);
        setTruncated(d.truncated);
      })
      .catch(() => {}); // a failed notice must never get in the way of signing in
    return () => { live = false; };
  }, [userId]);

  if (alerts.length === 0) return null;

  function dismiss() {
    writeSeen([...new Set([...readSeen(), ...alerts.map((a) => a.key)])]);
    setAlerts([]);
  }

  return (
    <div className="modal-backdrop" onClick={dismiss}>
      <div className="modal-panel" role="dialog" aria-label="AMC contracts needing attention" data-testid="amc-expiry-notice" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-lg font-semibold">AMC contracts needing attention</h3>
          <button onClick={dismiss} aria-label="Close" className="text-gray-400 hover:text-gray-600">✕</button>
        </div>
        <ul className="space-y-2 max-h-80 overflow-y-auto" data-testid="amc-expiry-notice-list">
          {alerts.map((a) => (
            <li key={a.key} className="rounded-lg border border-gray-200 p-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium">{a.partyName} <span className="font-mono text-xs text-gray-500">{a.ref}</span></span>
                <span className={a.status === "expired" ? "status-pill status-pill-error" : "status-pill status-pill-warning"}>{contractStatusLabel(a.status)}</span>
              </div>
              <div className="mt-1 text-xs text-gray-600">{a.kind === "vendor" ? "Vendor AMC" : "Customer AMC"}{a.amcType ? ` (${AMC_TYPE_LABELS[a.amcType] ?? a.amcType})` : ""} · {formatDay(a.startDate)} to {formatDay(a.endDate)} · Expiry {formatDay(a.endDate)} · {daysText(a.status, a.daysRemaining)}</div>
              {(a.kind === "vendor" ? a.customerName || a.siteName : a.siteName) && (
                <div className="mt-0.5 text-xs text-gray-500" data-testid="amc-notice-where">
                  {[a.kind === "vendor" ? a.customerName : null, a.siteName].filter(Boolean).join(" · ")}
                </div>
              )}
            </li>
          ))}
        </ul>
        {truncated && <p className="mt-2 text-xs text-gray-500">More contracts need attention than are listed here.</p>}
        <div className="mt-4 flex justify-end gap-3">
          {canOpenAmc && (
            <Link href={alerts.some((a) => a.kind === "customer") ? "/amc-orders" : "/vendor-amcs"} onClick={dismiss} className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50" data-testid="amc-notice-open">Open AMC</Link>
          )}
          <button onClick={dismiss} className="btn-primary px-4 py-2 text-sm" data-testid="amc-notice-dismiss">Dismiss</button>
        </div>
      </div>
    </div>
  );
}
