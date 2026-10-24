import test from "node:test";
import assert from "node:assert/strict";
import {
  eligibleComplaintUnits,
  requiresUnitSelection,
  resolveComplaintUnit,
  buildComplaintBody,
  createComplaintSchema,
} from "../src";

const active = (id: string) => ({ id, status: "active" });
const retired = (id: string) => ({ id, status: "retired" });

test("only units in service are eligible, and more than one forces a choice", () => {
  assert.deepEqual(eligibleComplaintUnits([active("a"), retired("b")]).map((u) => u.id), ["a"]);
  assert.equal(requiresUnitSelection([active("a")]), false);
  assert.equal(requiresUnitSelection([]), false);
  assert.equal(requiresUnitSelection([active("a"), active("b")]), true);
  assert.equal(requiresUnitSelection([active("a"), retired("b")]), false, "a retired unit never needs choosing");
});

test("resolveComplaintUnit: auto-picks the single unit, demands a choice for several, tolerates none", () => {
  assert.deepEqual(resolveComplaintUnit([active("a")], undefined), { unitId: "a" });
  assert.deepEqual(resolveComplaintUnit([active("a"), retired("b")], undefined), { unitId: "a" });
  assert.ok("error" in resolveComplaintUnit([active("a"), active("b")], undefined));
  assert.deepEqual(resolveComplaintUnit([], undefined), { unitId: undefined }, "legacy site with no units");
});

test("resolveComplaintUnit: a requested unit must belong to the site and be in service", () => {
  assert.deepEqual(resolveComplaintUnit([active("a"), active("b")], "b"), { unitId: "b" });
  assert.match((resolveComplaintUnit([active("a")], "other-customers-unit") as { error: string }).error, /does not belong to this site/);
  assert.match((resolveComplaintUnit([active("a"), retired("b")], "b") as { error: string }).error, /no longer in service/);
  assert.match((resolveComplaintUnit([], "x") as { error: string }).error, /does not belong/);
});

const fields = { siteId: "s1", category: "non_performance", description: "Noise", severity: "low", attachmentUrl: "data:image/png;base64,AA" };

test("buildComplaintBody sends the chosen unitId, and leaves it out when none was chosen", () => {
  const withUnit = buildComplaintBody({ ...fields, unitId: "u9" });
  assert.equal(withUnit.unitId, "u9");
  assert.equal(createComplaintSchema.parse(withUnit).unitId, "u9", "the API schema keeps it");
  for (const none of [undefined, null, ""]) {
    const body = buildComplaintBody({ ...fields, unitId: none });
    assert.equal("unitId" in body, false);
    assert.equal(createComplaintSchema.safeParse(body).success, true);
  }
});

test("the photo stays mandatory in the request schema", () => {
  const { attachmentUrl: _omit, ...noPhoto } = fields;
  assert.equal(createComplaintSchema.safeParse(noPhoto).success, false);
  assert.equal(createComplaintSchema.safeParse({ ...fields, attachmentUrl: "" }).success, false);
});
