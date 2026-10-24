import { RECD_UNIT_STATUS } from "./constants";

/**
 * One rule, used by the API and by every client (web portal, mobile app), for which RECD a
 * service complaint is about: a site may hold several units, so the complaint has to name one
 * unless there is only one it could possibly be.
 */

/** Units a complaint can be raised against: in service (not retired). */
export function eligibleComplaintUnits<T extends { status: string }>(units: readonly T[]): T[] {
  return units.filter((u) => u.status === RECD_UNIT_STATUS.ACTIVE);
}

/** True when the user must pick which RECD the complaint is about. */
export function requiresUnitSelection(units: readonly { status: string }[]): boolean {
  return eligibleComplaintUnits(units).length > 1;
}

export type ComplaintUnitResolution = { unitId: string | undefined } | { error: string };

/**
 * Decides which unit a new complaint attaches to.
 * - `siteUnits` are ALL units of the complaint's site (not of the customer).
 * - A requested unit must be one of them and still in service.
 * - With no request: the site's only eligible unit is used; several eligible units is an error;
 *   none (legacy site with no units) leaves the complaint unlinked, as before.
 */
export function resolveComplaintUnit(
  siteUnits: readonly { id: string; status: string }[],
  requestedUnitId: string | undefined,
): ComplaintUnitResolution {
  if (requestedUnitId) {
    const unit = siteUnits.find((u) => u.id === requestedUnitId);
    if (!unit) return { error: "That RECD does not belong to this site" };
    if (unit.status !== RECD_UNIT_STATUS.ACTIVE) return { error: "That RECD is no longer in service" };
    return { unitId: unit.id };
  }
  const eligible = eligibleComplaintUnits(siteUnits);
  if (eligible.length > 1) {
    return { error: "This site has more than one RECD - select the RECD serial number the complaint is about" };
  }
  return { unitId: eligible[0]?.id };
}

export interface ComplaintBodyFields {
  siteId: string;
  /** Empty string / null / undefined mean "no unit chosen" and are left out of the request. */
  unitId?: string | null;
  category: string;
  issueCategory?: string;
  description: string;
  severity: string;
  attachmentUrl: string;
}

/** The POST /complaints body. Shared so web and mobile cannot drift on how unitId is sent. */
export function buildComplaintBody(fields: ComplaintBodyFields) {
  const { unitId, ...rest } = fields;
  return unitId ? { ...rest, unitId } : { ...rest };
}
