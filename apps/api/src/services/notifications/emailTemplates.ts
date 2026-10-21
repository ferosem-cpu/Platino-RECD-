// Brand name printed in every outbound email's subject/header. Configurable so a white-label
// deployment (see §4's Super Admin / branding split) doesn't need a code change.
const BRAND = process.env.EMAIL_BRAND_NAME || "Platino";

interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

function wrap(bodyHtml: string): string {
  return `<div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto;"><h2 style="color: #111827;">${BRAND}</h2>${bodyHtml}</div>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Renders subject/text/html for a notification templateKey. Bespoke copy for the templates
 * users actually read closely (OTP sign-in, site stage updates, vendor site assignment).
 * Every other key falls through to a generic rendering of its data so nothing silently fails
 * to send, without guessing at copy/tone for templates nobody asked to have written yet.
 */
export function renderEmail(templateKey: string, data: Record<string, unknown>): RenderedEmail {
  if (templateKey === "otp_code") {
    const code = String(data.code ?? "");
    const context = data.orderNumber ? ` for order ${data.orderNumber}` : "";
    return {
      subject: `Your ${BRAND} sign-in code`,
      text: `Your one-time sign-in code${context} is: ${code}\n\nThis code expires in 10 minutes. If you didn't request this, you can ignore this email.`,
      html: wrap(`
        <p>Your one-time sign-in code${context} is:</p>
        <p style="font-size: 28px; font-weight: 700; letter-spacing: 6px; color: #111827; margin: 16px 0;">${code}</p>
        <p style="color: #6b7280; font-size: 13px;">This code expires in 10 minutes. If you didn't request this, you can ignore this email.</p>
      `),
    };
  }

  if (templateKey === "complaint_raised") {
    const ticket = String(data.ticketNumber ?? "");
    const lines = [
      data.serialNo ? `RECD serial no.: ${data.serialNo}` : null,
      data.issue ? `Issue: ${data.issue}` : null,
      data.reporterName
        ? `Reported by: ${data.reporterName}${data.reporterType ? ` (${String(data.reporterType).replace("_", "-")})` : ""}${data.reporterPhone ? `, ${data.reporterPhone}` : ""}`
        : null,
    ].filter((l): l is string => Boolean(l));
    return {
      subject: `${BRAND} — new service ticket ${ticket}`,
      text: `A new service ticket has been raised: ${ticket}\n\n${lines.join("\n")}`,
      html: wrap(`
        <p>A new service ticket has been raised:</p>
        <p style="font-size: 18px; font-weight: 700; color: #111827; margin: 12px 0 4px;">${escapeHtml(ticket)}</p>
        ${lines.map((l) => `<div>${escapeHtml(l)}</div>`).join("")}
      `),
    };
  }

  if (templateKey === "complaint_escalated") {
    const ticket = String(data.ticketNumber ?? "");
    const toMgmt = data.audience === "management";
    const lines = [
      data.customerName ? `Customer: ${data.customerName}` : null,
      data.serialNo ? `RECD serial no.: ${data.serialNo}` : null,
      `Status: ${String(data.status ?? "").replace(/_/g, " ")}`,
      `Open for: ${data.ageHours ?? "?"} hours`,
    ].filter((l): l is string => Boolean(l));
    const heading = toMgmt
      ? `Ticket ${ticket} is still unresolved and has been escalated to Management`
      : `Ticket ${ticket} is unresolved past its SLA and needs your attention`;
    return {
      subject: `${BRAND} — SLA escalation: ${ticket}`,
      text: `${heading}\n\n${lines.join("\n")}`,
      html: wrap(`
        <p>${escapeHtml(heading)}</p>
        ${lines.map((l) => `<div>${escapeHtml(l)}</div>`).join("")}
      `),
    };
  }

  if (templateKey === "complaint_status_updated") {
    const ticket = String(data.ticketNumber ?? "");
    const status = String(data.status ?? "").replace(/_/g, " ");
    const lines = [
      data.serialNo ? `RECD serial no.: ${data.serialNo}` : null,
      `New status: ${status}`,
    ].filter((l): l is string => Boolean(l));
    return {
      subject: `${BRAND} — update on your service ticket ${ticket}`,
      text: `There is an update on your service ticket ${ticket}.\n\n${lines.join("\n")}\n\nIf you have questions about this ticket, please reply to your usual ${BRAND} service contact and quote the ticket number.`,
      html: wrap(`
        <p>There is an update on your service ticket:</p>
        <p style="font-size: 18px; font-weight: 700; color: #111827; margin: 12px 0 4px;">${escapeHtml(ticket)}</p>
        ${lines.map((l) => `<div>${escapeHtml(l)}</div>`).join("")}
        <p style="color: #6b7280; font-size: 13px;">If you have questions about this ticket, please contact your usual ${escapeHtml(BRAND)} service contact and quote the ticket number.</p>
      `),
    };
  }

  if (templateKey === "complaint_assigned") {
    const ticket = String(data.ticketNumber ?? "");
    const lines = [
      data.customerName ? `Customer: ${data.customerName}` : null,
      data.serialNo ? `RECD serial no.: ${data.serialNo}` : null,
    ].filter((l): l is string => Boolean(l));
    return {
      subject: `${BRAND} — service ticket ${ticket} assigned to you`,
      text: `Service ticket ${ticket} has been assigned to you.${lines.length ? `\n\n${lines.join("\n")}` : ""}\n\nNext step: open the ticket in ${BRAND}, review the details and update its status as you progress.`,
      html: wrap(`
        <p>A service ticket has been assigned to you:</p>
        <p style="font-size: 18px; font-weight: 700; color: #111827; margin: 12px 0 4px;">${escapeHtml(ticket)}</p>
        ${lines.map((l) => `<div>${escapeHtml(l)}</div>`).join("")}
        <p style="font-size: 14px; color: #374151;"><strong>Next step:</strong> open the ticket in ${escapeHtml(BRAND)}, review the details and update its status as you progress.</p>
      `),
    };
  }

  if (templateKey === "service_digest") {
    const region = String(data.regionName ?? "");
    const rows = (Array.isArray(data.tickets) ? data.tickets : []) as Record<string, unknown>[];
    const line = (t: Record<string, unknown>) =>
      `${t.ticketNumber} — ${t.customerName}${t.siteName ? ` — ${t.siteName}` : ""} — serial ${t.serialNo ?? "not recorded"} — ${String(t.status ?? "").replace(/_/g, " ")} — open ${t.openDays ?? "?"} d${t.dueDate ? ` — due ${t.dueDate}${t.overdue ? " (OVERDUE)" : ""}` : ""}`;
    const more = Number(data.openCount ?? rows.length) - rows.length;
    const summary = `${data.openCount ?? rows.length} open ticket(s), ${data.overdueCount ?? 0} overdue`;
    return {
      subject: `${BRAND} — daily service digest: ${region} (${data.overdueCount ?? 0} overdue)`,
      text: `Daily service digest for ${region}\n${summary}\n\n${rows.map(line).join("\n")}${more > 0 ? `\n…and ${more} more` : ""}`,
      html: wrap(`
        <p>Daily service digest for <strong>${escapeHtml(region)}</strong></p>
        <p style="color: #6b7280;">${escapeHtml(summary)}</p>
        ${rows.map((t) => `<div style="margin: 4px 0;">${escapeHtml(line(t))}</div>`).join("")}
        ${more > 0 ? `<p style="color: #6b7280;">…and ${more} more</p>` : ""}
      `),
    };
  }

  if (templateKey === "service_reminder" || templateKey === "service_reminder_escalated") {
    const escalated = templateKey === "service_reminder_escalated";
    const isVisit = data.activityType === "amc_visit";
    const what = isVisit ? `AMC visit (${data.activityRef})` : `Service ticket ${data.activityRef}`;
    const lines = [
      `Activity: ${what}`,
      `Customer: ${data.customerName ?? "-"}`,
      `Site: ${data.siteName ?? "not recorded"}`,
      `RECD serial no.: ${data.serialNo ?? "not recorded"}`,
      `Due date: ${data.dueDate ?? "-"}${data.overdue ? " (OVERDUE)" : ""}`,
      data.link ? `Open: ${data.link}` : null,
    ].filter((l): l is string => Boolean(l));
    const heading = escalated
      ? `Reminder not acknowledged - escalation level ${data.level ?? ""}: ${what} needs attention`
      : data.overdue
        ? `Overdue: ${what}`
        : `Due soon: ${what}`;
    return {
      subject: `${BRAND} — ${escalated ? "ESCALATED reminder" : "Service reminder"}: ${data.activityRef ?? ""}`,
      text: [heading, "", ...lines, "", "Please acknowledge this reminder in the Platino RECD Tracker."].join("\n"),
      html: wrap(`
        <p style="font-weight: 700;">${escapeHtml(heading)}</p>
        ${lines.map((l) => `<div>${escapeHtml(l)}</div>`).join("")}
        <p style="color: #6b7280; font-size: 13px;">Please acknowledge this reminder in the Platino RECD Tracker.</p>
      `),
    };
  }

  if (templateKey === "warranty_expiry_reminder") {
    const expiry = String(data.expiryDate ?? "-");
    const days = typeof data.daysRemaining === "number" ? (data.daysRemaining === 0 ? "expires today" : `${data.daysRemaining} day${data.daysRemaining === 1 ? "" : "s"} left`) : null;
    const heading = `Warranty of RECD ${data.serialNo ?? "(serial not recorded)"} ends on ${expiry}${days ? ` (${days})` : ""}`;
    const lines = [
      `Serial no.: ${data.serialNo ?? "not recorded"}`,
      `Product: ${data.productName ?? "-"}`,
      `Customer: ${data.customerName ?? "-"}`,
      `Site: ${data.siteName ?? "not recorded"}`,
      `Warranty expiry date: ${expiry}`,
      `Warranty status: ${String(data.status ?? "").replace(/_/g, " ")}`,
      data.link ? `Open: ${data.link}` : null,
    ].filter((l): l is string => Boolean(l));
    return {
      subject: `${BRAND} — Warranty expiry: ${data.serialNo ?? ""}`,
      text: [heading, "", ...lines].join("\n"),
      html: wrap(`
        <p style="font-weight: 700;">${escapeHtml(heading)}</p>
        ${lines.map((l) => `<div>${escapeHtml(l)}</div>`).join("")}
      `),
    };
  }

  if (templateKey === "amc_expiry_reminder") {
    const vendor = data.kind === "vendor";
    const expiry = String(data.expiryDate ?? "").slice(0, 10) || "-";
    const ref = String(data.ref ?? data.poNo ?? "");
    const typeLabel = String(data.amcTypeLabel ?? (vendor ? "Vendor AMC" : "Customer AMC"));
    const days = typeof data.daysRemaining === "number" ? data.daysRemaining : null;
    const remaining = days === null ? null : days > 0 ? `${days} day${days === 1 ? "" : "s"}` : days === 0 ? "expires today" : `expired ${Math.abs(days)} day${days === -1 ? "" : "s"} ago`;
    const heading = vendor ? `Vendor AMC contract ${ref} is due to expire on ${expiry}` : `AMC order ${ref} is due to expire on ${expiry}`;
    const lines = [
      `AMC type: ${typeLabel}${!vendor && data.amcType ? ` (${String(data.amcType).toUpperCase()})` : ""}`,
      // the customer / site only when there is one (a vendor contract may be a general agreement with the vendor)
      ...(data.customerName ? [`Customer: ${data.customerName}`] : vendor ? [] : ["Customer: -"]),
      ...(data.siteName ? [`Site: ${data.siteName}`] : vendor ? [] : ["Site: -"]),
      ...(vendor ? [`Vendor: ${data.vendorName ?? "-"}`] : []),
      `Expiry date: ${expiry}`,
      ...(remaining ? [`Remaining: ${remaining}`] : []),
    ];
    const where = data.actionUrl ? String(data.actionUrl) : data.actionPath ? `${vendor ? "Vendor AMC" : "AMC Order"} page (${data.actionPath})` : null;
    const action = `Open the ${vendor ? "Vendor AMC" : "AMC Order"} page to view it or renew it${where ? `: ${where}` : ""}, or mark it AMC Acquired to stop these reminders.`;
    return {
      subject: `${BRAND} — ${typeLabel} expiry: ${ref}`,
      text: [heading, "", ...lines, "", action].join("\n"),
      html: wrap(`
        <p style="font-weight: 700;">${escapeHtml(heading)}</p>
        ${lines.map((l) => `<div>${escapeHtml(l)}</div>`).join("")}
        <p style="color: #6b7280; font-size: 13px;">${escapeHtml(action)}</p>
      `),
    };
  }

  if (templateKey === "site_stage_updated") {
    const stage = String(data.stage ?? "");
    const status = String(data.status ?? "");
    const comment = data.comment ? String(data.comment) : null;
    const orderNumber = data.orderNumber ? String(data.orderNumber) : null;
    const address = data.address ? String(data.address) : null;
    const companyName = data.companyName ? String(data.companyName) : null;
    const recdUnits = Array.isArray(data.recdUnits) ? data.recdUnits.map((u) => String(u)) : [];

    const siteDetailLines = [
      orderNumber ? `Order: ${orderNumber}` : null,
      companyName ? `Site: ${companyName}` : null,
      address ? `Address: ${address}` : null,
      recdUnits.length ? `RECD unit(s): ${recdUnits.join(", ")}` : null,
    ].filter((l): l is string => l !== null);

    const siteDetailHtml = siteDetailLines.length
      ? `<div style="background: #f9fafb; border-radius: 6px; padding: 10px 14px; margin: 12px 0; font-size: 13px; color: #374151;">
          ${[
            orderNumber ? `<div><strong>Order:</strong> ${escapeHtml(orderNumber)}</div>` : "",
            companyName ? `<div><strong>Site:</strong> ${escapeHtml(companyName)}</div>` : "",
            address ? `<div><strong>Address:</strong> ${escapeHtml(address)}</div>` : "",
            recdUnits.length ? `<div><strong>RECD unit(s):</strong> ${escapeHtml(recdUnits.join(", "))}</div>` : "",
          ].join("")}
        </div>`
      : "";

    return {
      subject: `${BRAND} — installation update: ${stage}${orderNumber ? ` (${orderNumber})` : ""}`,
      text: `Your installation has moved to a new stage.\n\nStage: ${stage}\nStatus: ${status}${comment ? `\nNote: ${comment}` : ""}${siteDetailLines.length ? `\n\n${siteDetailLines.join("\n")}` : ""}`,
      html: wrap(`
        <p>Your installation has moved to a new stage:</p>
        <p style="font-size: 20px; font-weight: 700; color: #111827; margin: 12px 0 4px;">${escapeHtml(stage)}</p>
        <p style="color: #6b7280; margin: 0 0 12px;">${escapeHtml(status)}</p>
        ${comment ? `<p style="font-size: 14px; color: #374151; border-left: 3px solid #e5e7eb; padding-left: 10px;">${escapeHtml(comment)}</p>` : ""}
        ${siteDetailHtml}
      `),
    };
  }

  if (templateKey === "vendor_assigned_site") {
    const orderNumber = String(data.orderNumber ?? "");
    const customerName = String(data.customerName ?? "");
    const address = data.address ? String(data.address) : null;
    return {
      subject: `${BRAND} — new site assigned: ${orderNumber}`,
      text: `You've been assigned to a site.\n\nOrder: ${orderNumber}\nCustomer: ${customerName}${address ? `\nAddress: ${address}` : ""}`,
      html: wrap(`
        <p>You've been assigned to a new site:</p>
        <p style="font-size: 18px; font-weight: 700; color: #111827; margin: 12px 0 4px;">${orderNumber}</p>
        <p style="color: #6b7280; margin: 0 0 4px;">${customerName}</p>
        ${address ? `<p style="font-size: 14px; color: #374151;">${address}</p>` : ""}
      `),
    };
  }

  const label = templateKey.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  const rows = Object.entries(data)
    .map(([key, value]) => `<tr><td style="padding:2px 8px 2px 0;color:#6b7280;">${escapeHtml(key)}</td><td>${escapeHtml(String(value))}</td></tr>`)
    .join("");
  const textRows = Object.entries(data).map(([key, value]) => `${key}: ${value}`).join("\n");
  return {
    subject: `${BRAND} — ${label}`,
    text: `${label}\n\n${textRows}`,
    html: wrap(`<p style="font-weight: 600;">${escapeHtml(label)}</p><table style="font-size: 14px;">${rows}</table>`),
  };
}
