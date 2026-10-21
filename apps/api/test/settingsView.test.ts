// GET /settings used to return the whole CompanySettings row to ANY signed-in user, customers and vendors included.
process.env.JWT_SECRET = "test-secret";
process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:1/test";
process.env.DIRECT_URL = process.env.DATABASE_URL;

import test from "node:test";
import assert from "node:assert/strict";
import { PERMISSION_KEY } from "@recd/shared";

const row = {
  id: "singleton", logoDataUrl: "data:x", themeKey: "emerald", customColors: null, legalName: "Platino", address: "A", city: "C", pinCode: "1", email: "e@x", website: "w", phone: "p", documentFooterNote: null,
  agentVisibleRoleKeys: ["super_admin"], agentCustomInstructions: "internal assistant rules",
  slaRegionalManagerHours: 24, slaManagementHours: 48, reminderLeadDays: 3, reminderEscalationHours: 24, amcDefaultDurationMonths: 12, amcReminderLeadDays: 30, amcReminderRepeatDays: 3, warrantyReminderLeadDays: 30, warrantyReminderRepeatDays: 3,
};

test("settings view: customers and vendors get branding and contact details only; staff get the policies; the assistant's custom instructions need manage_settings", async () => {
  const { settingsViewFor } = await import("../src/routes/settings");
  const customer = settingsViewFor(row, { customerId: "c1", permissions: new Set() }) as Record<string, unknown>;
  const vendor = settingsViewFor(row, { vendorId: "v1", permissions: new Set([PERMISSION_KEY.MANAGE_SETTINGS]) }) as Record<string, unknown>;
  for (const v of [customer, vendor]) {
    for (const hidden of ["agentCustomInstructions", "slaRegionalManagerHours", "slaManagementHours", "reminderLeadDays", "reminderEscalationHours", "amcReminderLeadDays", "warrantyReminderLeadDays"]) assert.ok(!(hidden in v), `${hidden} is not for customers / vendors`);
    for (const shown of ["themeKey", "logoDataUrl", "legalName", "phone", "agentVisibleRoleKeys"]) assert.ok(shown in v, shown);
  }
  const rm = settingsViewFor(row, { permissions: new Set([PERMISSION_KEY.MANAGE_COMPLAINTS]) }) as Record<string, unknown>;
  assert.equal(rm.slaRegionalManagerHours, 24);
  assert.ok(!("agentCustomInstructions" in rm), "staff without manage_settings do not see the assistant instructions");
  const admin = settingsViewFor(row, { permissions: new Set([PERMISSION_KEY.MANAGE_SETTINGS]) }) as Record<string, unknown>;
  assert.equal(admin.agentCustomInstructions, "internal assistant rules");
});
