import { SLA_DEFAULTS, SLA_PAUSED_STATUSES } from "@recd/shared";

export interface SlaWindows {
  regionalManagerHours: number;
  managementHours: number;
}

export const DEFAULT_SLA: SlaWindows = {
  regionalManagerHours: SLA_DEFAULTS.REGIONAL_MANAGER_HOURS,
  managementHours: SLA_DEFAULTS.MANAGEMENT_HOURS,
};

export function slaFromSettings(
  s: { slaRegionalManagerHours?: number | null; slaManagementHours?: number | null } | null | undefined,
): SlaWindows {
  const rm = s?.slaRegionalManagerHours ?? DEFAULT_SLA.regionalManagerHours;
  const mg = s?.slaManagementHours ?? DEFAULT_SLA.managementHours;
  // Never let management come before the Regional Manager, whatever is stored.
  return { regionalManagerHours: rm, managementHours: Math.max(mg, rm) };
}

/**
 * Escalation level a ticket has earned by now: 0 none, 1 Regional Manager, 2 Management.
 * Finished tickets and tickets waiting on the customer do not escalate.
 */
export function targetEscalationLevel(
  ticket: { status: string; createdAt: Date },
  sla: SlaWindows,
  now: Date = new Date(),
): 0 | 1 | 2 {
  if (SLA_PAUSED_STATUSES.includes(ticket.status)) return 0;
  const ageHours = (now.getTime() - ticket.createdAt.getTime()) / 3_600_000;
  if (ageHours >= sla.managementHours) return 2;
  if (ageHours >= sla.regionalManagerHours) return 1;
  return 0;
}
