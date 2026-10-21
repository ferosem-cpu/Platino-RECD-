import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeIndianMobile,
  indianMobileSchema,
  recdSerialSchema,
  createOrderSchema,
  addOrderLineItemSchema,
  createAmcOrderSchema,
  createUserSchema,
} from "../src/schemas";

test("normalizeIndianMobile accepts common Indian formats and returns bare 10 digits", () => {
  for (const input of ["9884977994", "+919884977994", "919884977994", "09884977994", "98849 77994", "98849-77994", " +91 98849 77994 "]) {
    assert.equal(normalizeIndianMobile(input), "9884977994", input);
  }
});

test("normalizeIndianMobile rejects invalid numbers", () => {
  for (const input of ["", "12345", "5884977994", "98849779940", "abcdefghij", "+1 4155552671", "98849779"]) {
    assert.equal(normalizeIndianMobile(input), null, input);
  }
});

test("indianMobileSchema transforms to the normalised value", () => {
  assert.equal(indianMobileSchema.parse("+91 98849 77994"), "9884977994");
  assert.equal(indianMobileSchema.safeParse("123").success, false);
});

test("recdSerialSchema trims, upper-cases and restricts characters", () => {
  assert.equal(recdSerialSchema.parse("  rc-2026/0001 "), "RC-2026/0001");
  assert.equal(recdSerialSchema.safeParse("ab").success, false);
  assert.equal(recdSerialSchema.safeParse("-leading").success, false);
  assert.equal(recdSerialSchema.safeParse("has space").success, false);
  assert.equal(recdSerialSchema.safeParse("x".repeat(41)).success, false);
});

const baseOrder = { customerId: "c", productId: "p", quantity: 2, poNumber: "PO-1" };

test("createOrderSchema requires exactly one distinct serial per unit", () => {
  assert.equal(createOrderSchema.safeParse({ ...baseOrder, recdSerials: ["A-100", "A-101"] }).success, true);
  assert.equal(createOrderSchema.safeParse({ ...baseOrder, recdSerials: ["A-100"] }).success, false, "too few");
  assert.equal(createOrderSchema.safeParse({ ...baseOrder, recdSerials: ["A-100", "A-101", "A-102"] }).success, false, "too many");
  assert.equal(createOrderSchema.safeParse({ ...baseOrder, recdSerials: ["A-100", "a-100"] }).success, false, "duplicates ignoring case");
});

test("createOrderSchema requires a PO number", () => {
  assert.equal(createOrderSchema.safeParse({ ...baseOrder, poNumber: "  ", recdSerials: ["A-100", "A-101"] }).success, false);
  const { poNumber: _omit, ...noPo } = baseOrder;
  assert.equal(createOrderSchema.safeParse({ ...noPo, recdSerials: ["A-100", "A-101"] }).success, false);
});

test("addOrderLineItemSchema enforces serial count", () => {
  assert.equal(addOrderLineItemSchema.safeParse({ productId: "p", quantity: 1, recdSerials: ["Z-1X"] }).success, true);
  assert.equal(addOrderLineItemSchema.safeParse({ productId: "p", quantity: 2, recdSerials: ["Z-1X"] }).success, false);
});

test("createUserSchema makes mobile mandatory and normalises it", () => {
  const ok = createUserSchema.parse({ name: "A", email: "a@b.co", roleKey: "regional_manager", phone: "+91 98849 77994" });
  assert.equal(ok.phone, "9884977994");
  assert.equal(createUserSchema.safeParse({ name: "A", email: "a@b.co", roleKey: "sales" }).success, false);
  assert.equal(createUserSchema.safeParse({ name: "A", email: "a@b.co", roleKey: "sales", phone: "12" }).success, false);
});

test("createAmcOrderSchema: unitIds optional, defaults to none, rejects repeats", () => {
  const base = { poNo: "P1", poDate: "2026-01-01T00:00:00.000Z", customerId: "c", location: "L", item: "RECD", qty: 2, amcFrequencyPerYear: 4, amcType: "camc" };
  const none = createAmcOrderSchema.parse(base);
  assert.deepEqual(none.unitIds, []);
  assert.deepEqual(createAmcOrderSchema.parse({ ...base, unitIds: ["u1", "u2"] }).unitIds, ["u1", "u2"]);
  assert.equal(createAmcOrderSchema.safeParse({ ...base, unitIds: ["u1", "u1"] }).success, false);
  assert.equal(createAmcOrderSchema.safeParse({ ...base, unitIds: [""] }).success, false);
});
