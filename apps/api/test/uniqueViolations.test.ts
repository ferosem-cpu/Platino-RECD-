import test from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";
import {
  isOpenComplaintConflict,
  isOrderNumberConflict,
  isSerialConflict,
  isTicketNumberConflict,
  isUserEmailConflict,
  isUserPhoneConflict,
  orderNumberConflictMessage,
  uniqueViolationTarget,
} from "../src/lib/uniqueViolations";

const err = (code: string, meta?: Record<string, unknown>) =>
  new Prisma.PrismaClientKnownRequestError("x", { code, clientVersion: "5.22.0", meta });

// The shapes below are what this project's Postgres + Prisma 5.22 actually produce
// (captured from the isolated test database; see the real-database test for the live check).
const serial = err("P2002", { modelName: "RecdUnit", target: ["serialNo"] });
const orderNumber = err("P2002", { modelName: "Order", target: ["orderNumber"] });
const openComplaint = err("P2002", { modelName: "Complaint", target: ["unitId"] });
const ticketNumber = err("P2002", { modelName: "Complaint", target: ["ticketNumber"] });
const foreignKey = err("P2003", { modelName: "Complaint", field_name: "Complaint_siteId_fkey (index)" });

test("each unique violation is recognised as exactly one thing", () => {
  const checks = { serial: isSerialConflict, orderNumber: isOrderNumberConflict, openComplaint: isOpenComplaintConflict };
  const table: Array<[string, unknown, keyof typeof checks | null]> = [
    ["serial", serial, "serial"],
    ["orderNumber", orderNumber, "orderNumber"],
    ["openComplaint", openComplaint, "openComplaint"],
    ["ticketNumber", ticketNumber, null], // its own check is asserted below
    ["foreign key", foreignKey, null],
    ["plain Error", new Error("boom"), null],
    ["null", null, null],
    ["string", "P2002", null],
  ];
  for (const [label, e, expected] of table) {
    for (const [name, fn] of Object.entries(checks)) {
      assert.equal(fn(e), name === expected, `${label} vs ${name}`);
    }
  }
});

test("a unique violation with unknown or foreign details is never claimed by a specific check", () => {
  for (const e of [
    err("P2002"),
    err("P2002", {}),
    err("P2002", { modelName: "Order" }),
    err("P2002", { modelName: "User", target: ["email"] }),
    err("P2002", { modelName: "Order", target: ["serialNo"] }),
    err("P2002", { modelName: "RecdUnit", target: ["orderNumber"] }),
  ]) {
    assert.equal(isSerialConflict(e) && isOrderNumberConflict(e), false);
  }
  assert.equal(isSerialConflict(err("P2002")), false);
  assert.equal(isOrderNumberConflict(err("P2002", { modelName: "User", target: ["orderNumber"] })), false, "model must match");
  assert.equal(isOpenComplaintConflict(err("P2002", { modelName: "Order", target: ["unitId"] })), false);
});

test("an index name given as a string (other drivers) still identifies the column", () => {
  assert.equal(isSerialConflict(err("P2002", { modelName: "RecdUnit", target: "RecdUnit_serialNo_key" })), true);
  assert.equal(isOrderNumberConflict(err("P2002", { target: "Order_orderNumber_key" })), true, "no model name: column decides");
});

test("uniqueViolationTarget exposes the model and columns, and ignores other errors", () => {
  assert.deepEqual(uniqueViolationTarget(serial), { model: "RecdUnit", fields: ["serialNo"] });
  assert.equal(uniqueViolationTarget(foreignKey), null);
  assert.equal(uniqueViolationTarget(new Error("x")), null);
});

test("the order-number message names the order number, not a serial", () => {
  const m = orderNumberConflictMessage("ORD-2026-1234");
  assert.match(m, /ORD-2026-1234/);
  assert.match(m, /submit again/);
  assert.doesNotMatch(m, /serial/i);
});

test("a duplicate mobile number is recognised for a direct user write AND for a contact created inside a customer", () => {
  assert.equal(isUserPhoneConflict(err("P2002", { modelName: "User", target: ["phone"] })), true);
  assert.equal(isUserPhoneConflict(err("P2002", { modelName: "Customer", target: ["phone"] })), true, "nested create reports the parent model");
  for (const e of [err("P2002", { modelName: "User", target: ["email"] }), err("P2002", { modelName: "Customer", target: ["name"] }), err("P2002", { modelName: "Order", target: ["phone"] }), err("P2002"), serial, foreignKey, new Error("x"), null]) {
    assert.equal(isUserPhoneConflict(e), false);
  }
});

test("a ticket-number collision is recognised only as a ticket-number collision", () => {
  assert.equal(isTicketNumberConflict(ticketNumber), true);
  for (const e of [serial, orderNumber, openComplaint, foreignKey, new Error("x"), null, err("P2002"), err("P2002", { modelName: "User", target: ["ticketNumber"] })]) {
    assert.equal(isTicketNumberConflict(e), false);
  }
});

test("a duplicate email is recognised for a user write and a nested customer contact, and never confused with the phone", () => {
  const userEmail = err("P2002", { modelName: "User", target: ["email"] });
  const customerEmail = err("P2002", { modelName: "Customer", target: ["email"] });
  assert.equal(isUserEmailConflict(userEmail), true);
  assert.equal(isUserEmailConflict(customerEmail), true);
  assert.equal(isUserPhoneConflict(userEmail), false);
  assert.equal(isUserEmailConflict(err("P2002", { modelName: "User", target: ["phone"] })), false);
  assert.equal(isUserEmailConflict(err("P2002", { modelName: "Vendor", target: ["contactEmail"] })), false, "other models' email columns are not claimed");
  assert.equal(isUserEmailConflict(err("P2002")), false);
  assert.equal(isUserEmailConflict(err("P2003", { modelName: "User" })), false);
  assert.equal(isUserEmailConflict(new Error("email")), false);
});
