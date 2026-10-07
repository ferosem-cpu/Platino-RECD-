import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SLA, slaFromSettings, targetEscalationLevel } from "../src/lib/sla";

const t0 = new Date("2026-10-01T00:00:00Z");
const at = (h: number) => new Date(t0.getTime() + h * 3_600_000);

test("defaults are 24h / 48h", () => {
  assert.deepEqual(slaFromSettings(null), DEFAULT_SLA);
  assert.equal(DEFAULT_SLA.regionalManagerHours, 24);
  assert.equal(DEFAULT_SLA.managementHours, 48);
});

test("management window is never before the regional window", () => {
  const s = slaFromSettings({ slaRegionalManagerHours: 30, slaManagementHours: 10 });
  assert.equal(s.managementHours, 30);
});

test("open ticket escalates in stages", () => {
  const ticket = { status: "open", createdAt: t0 };
  assert.equal(targetEscalationLevel(ticket, DEFAULT_SLA, at(23.9)), 0);
  assert.equal(targetEscalationLevel(ticket, DEFAULT_SLA, at(24)), 1);
  assert.equal(targetEscalationLevel(ticket, DEFAULT_SLA, at(47.9)), 1);
  assert.equal(targetEscalationLevel(ticket, DEFAULT_SLA, at(48)), 2);
  assert.equal(targetEscalationLevel(ticket, DEFAULT_SLA, at(500)), 2);
});

test("in-progress tickets still escalate", () => {
  assert.equal(targetEscalationLevel({ status: "in_progress", createdAt: t0 }, DEFAULT_SLA, at(30)), 1);
});

test("resolved, closed and waiting-for-customer tickets never escalate", () => {
  for (const status of ["resolved", "closed", "waiting_for_customer"]) {
    assert.equal(targetEscalationLevel({ status, createdAt: t0 }, DEFAULT_SLA, at(100)), 0);
  }
});

test("custom windows apply", () => {
  const sla = slaFromSettings({ slaRegionalManagerHours: 4, slaManagementHours: 8 });
  assert.equal(targetEscalationLevel({ status: "open", createdAt: t0 }, sla, at(5)), 1);
  assert.equal(targetEscalationLevel({ status: "open", createdAt: t0 }, sla, at(9)), 2);
});
