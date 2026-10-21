"use client";

import { ticketContactRows, type TicketContactInfo } from "@/lib/contactDisplay";

/**
 * Who to call about a ticket. Each row says which record the person comes from (the reporter of a
 * public ticket, the site POC, a site contact, the customer's contact) because they are not
 * necessarily the same person. Renders nothing when the API sent no contact information (the
 * viewer's role does not get it).
 */
export default function TicketContacts({ info }: { info: TicketContactInfo | undefined | null }) {
  const rows = ticketContactRows(info);
  if (!info) return null;
  return (
    <div className="mb-4 rounded-lg border border-gray-100 p-3" data-testid="ticket-contacts">
      <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-500">Contacts</p>
      {rows.length === 0 ? (
        <p className="text-sm text-gray-400">No contact people on file for this ticket.</p>
      ) : (
        <ul className="space-y-1.5 text-sm">
          {rows.map((r, i) => (
            <li key={`${r.kind}-${i}`} data-testid={`ticket-contact-${r.kind}`}>
              <span className="text-xs text-gray-400">{r.heading}: </span>
              <span className="font-medium text-gray-800">{r.name}</span>
              <span className={r.hasPhone ? "text-gray-600" : "text-amber-600"}> · {r.phone}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
