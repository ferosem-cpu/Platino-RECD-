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
    .map(([key, value]) => `<tr><td style="padding:2px 8px 2px 0;color:#6b7280;">${key}</td><td>${String(value)}</td></tr>`)
    .join("");
  const textRows = Object.entries(data).map(([key, value]) => `${key}: ${value}`).join("\n");
  return {
    subject: `${BRAND} — ${label}`,
    text: `${label}\n\n${textRows}`,
    html: wrap(`<p style="font-weight: 600;">${label}</p><table style="font-size: 14px;">${rows}</table>`),
  };
}
