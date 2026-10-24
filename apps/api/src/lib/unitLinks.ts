import { RECD_UNIT_STATUS, ROLE_KEY } from "@recd/shared";

/** The fields of a RECD unit that linking / access decisions depend on. */
export interface UnitLinkInfo {
  id: string;
  serialNo: string | null;
  status: string;
  /** Customer the unit was sold to (order.customerId). */
  customerId: string;
}

/**
 * Checks that every requested unit exists, has a serial, is active, and belongs to `customerId`.
 * Returns a human-readable error, or null when the link set is valid. Pure so it can be tested
 * without a database.
 */
export function validateAmcUnitLinks(requestedIds: string[], found: UnitLinkInfo[], customerId: string): string | null {
  const byId = new Map(found.map((u) => [u.id, u]));
  const missing = requestedIds.filter((id) => !byId.has(id));
  if (missing.length) return `Unknown RECD unit(s): ${missing.join(", ")}`;

  const foreign = found.filter((u) => u.customerId !== customerId);
  if (foreign.length) {
    return `These RECD units do not belong to the selected customer: ${foreign.map((u) => u.serialNo ?? u.id).join(", ")}`;
  }
  const noSerial = found.filter((u) => !u.serialNo);
  if (noSerial.length) return "Enter the serial number for every RECD unit before linking it to an AMC";
  const retired = found.filter((u) => u.status === RECD_UNIT_STATUS.RETIRED);
  if (retired.length) return `Retired RECD units cannot be added to an AMC: ${retired.map((u) => u.serialNo).join(", ")}`;
  return null;
}

export interface UnitAccessSubject {
  customerId: string;
  vendorId: string | null;
  regionId: string | null;
}

export interface UnitAccessAuth {
  roleKey: string;
  customerId?: string | null;
  vendorId?: string | null;
}

/**
 * Same scoping the rest of the API applies, in one place: customers see only their own units,
 * vendors only units at sites they erect, Regional Managers only units in their regions.
 * Everyone else with the route's permission sees all.
 */
export function canViewUnit(auth: UnitAccessAuth, unit: UnitAccessSubject, managedRegionIds: string[]): boolean {
  if (auth.customerId) return unit.customerId === auth.customerId;
  if (auth.vendorId) return unit.vendorId === auth.vendorId;
  if (auth.roleKey === ROLE_KEY.REGIONAL_MANAGER) {
    return !!unit.regionId && managedRegionIds.includes(unit.regionId);
  }
  return true;
}
