import test from "node:test";
import assert from "node:assert/strict";
import { ROLE_KEY } from "@recd/shared";
import { parseSerialList } from "../src/lib/serials";
import { validateAmcUnitLinks, canViewUnit, type UnitLinkInfo } from "../src/lib/unitLinks";

const u = (id: string, over: Partial<UnitLinkInfo> = {}): UnitLinkInfo => ({ id, serialNo: `SN-${id}`, status: "active", customerId: "c1", ...over });

test("validateAmcUnitLinks accepts active, serialled units of the same customer", () => {
  assert.equal(validateAmcUnitLinks(["a", "b"], [u("a"), u("b")], "c1"), null);
  assert.equal(validateAmcUnitLinks([], [], "c1"), null);
});

test("validateAmcUnitLinks names the offending serials", () => {
  assert.match(validateAmcUnitLinks(["a", "x"], [u("a")], "c1")!, /Unknown RECD unit\(s\): x/);
  assert.match(validateAmcUnitLinks(["a", "b"], [u("a"), u("b", { customerId: "c2" })], "c1")!, /SN-b/);
  assert.match(validateAmcUnitLinks(["a"], [u("a", { serialNo: null })], "c1")!, /serial number/);
  assert.match(validateAmcUnitLinks(["a"], [u("a", { status: "retired" })], "c1")!, /Retired.*SN-a/);
});

test("canViewUnit scopes by customer, vendor and region", () => {
  const unit = { customerId: "c1", vendorId: "v1", regionId: "r1" };
  assert.equal(canViewUnit({ roleKey: ROLE_KEY.CUSTOMER, customerId: "c1" }, unit, []), true);
  assert.equal(canViewUnit({ roleKey: ROLE_KEY.CUSTOMER, customerId: "c2" }, unit, []), false);
  assert.equal(canViewUnit({ roleKey: ROLE_KEY.ERECTION_ENGINEER, vendorId: "v1" }, unit, []), true);
  assert.equal(canViewUnit({ roleKey: ROLE_KEY.ERECTION_ENGINEER, vendorId: "v2" }, unit, []), false);
  assert.equal(canViewUnit({ roleKey: ROLE_KEY.REGIONAL_MANAGER }, unit, ["r1"]), true);
  assert.equal(canViewUnit({ roleKey: ROLE_KEY.REGIONAL_MANAGER }, unit, ["r2"]), false);
  assert.equal(canViewUnit({ roleKey: ROLE_KEY.REGIONAL_MANAGER }, { ...unit, regionId: null }, ["r1"]), false);
  assert.equal(canViewUnit({ roleKey: ROLE_KEY.MANAGEMENT }, unit, []), true);
});

test("parseSerialList enforces count, format and uniqueness and normalises case", () => {
  assert.deepEqual(parseSerialList([" ab-1 ", "cd-2"], 2), { serials: ["AB-1", "CD-2"] });
  for (const bad of [undefined, null, [], "AB-1"]) assert.ok("error" in parseSerialList(bad, 1), String(bad));
  assert.ok("error" in parseSerialList(["AB-1"], 2), "too few");
  assert.ok("error" in parseSerialList(["AB-1", "AB-2"], 1), "too many");
  assert.ok("error" in parseSerialList(["AB-1", "ab-1"], 2), "duplicate ignoring case");
  assert.ok("error" in parseSerialList(["!!"], 1), "bad format");
});
