import test from "node:test";
import assert from "node:assert/strict";
import { NO_MOBILE_LABEL, emailWithMobile, mobileOrNone, nameWithMobile, ticketContactRows, type TicketContactInfo } from "../src/lib/contactDisplay";

// Synthetic numbers only.
const full: TicketContactInfo = {
  reporter: { name: "Mani", type: "re_reseller", phone: "9000000004" },
  sitePoc: { name: "Ravi", phone: "9000000001" },
  siteContacts: [
    { id: "a", name: "Security desk", role: "Security head", phone: "9000000002" },
    { id: "b", name: "Facility manager", role: null, phone: null },
  ],
  customerContact: { name: "Asha", phone: "9000000003" },
};

test("a missing number is shown as the standard text, never blank and never another person's number", () => {
  assert.equal(NO_MOBILE_LABEL, "No mobile number on file");
  for (const empty of [null, undefined, "", "   "]) assert.equal(mobileOrNone(empty), NO_MOBILE_LABEL);
  assert.equal(mobileOrNone(" 9000000001 "), "9000000001");
});

test("the ticket screen lists each person under the record they come from, in a fixed order", () => {
  const rows = ticketContactRows(full);
  assert.deepEqual(rows.map((r) => r.kind), ["reporter", "sitePoc", "siteContact", "siteContact", "customerContact"]);
  assert.deepEqual(rows.map((r) => r.heading), ["Reported by (re reseller)", "Site POC", "Site contact · Security head", "Site contact", "Customer contact"]);
  assert.deepEqual(rows.map((r) => r.phone), ["9000000004", "9000000001", "9000000002", NO_MOBILE_LABEL, "9000000003"]);
  assert.deepEqual(rows.map((r) => r.hasPhone), [true, true, true, false, true]);
  assert.equal(new Set(rows.filter((r) => r.hasPhone).map((r) => r.phone)).size, 4, "no number appears under two people");
});

test("a person without a name or number is still listed, with clear text", () => {
  const rows = ticketContactRows({ reporter: null, sitePoc: { name: null, phone: null }, siteContacts: [], customerContact: null });
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].name, rows[0].phone], ["Name not on file", NO_MOBILE_LABEL]);
});

test("no contact information from the API (the role does not get it) means nothing is listed", () => {
  assert.deepEqual(ticketContactRows(undefined), []);
  assert.deepEqual(ticketContactRows(null), []);
});

test("a portal ticket has no 'reported by' row", () => {
  const rows = ticketContactRows({ ...full, reporter: null });
  assert.ok(!rows.some((r) => r.kind === "reporter"));
});

test("the customers list and vendors page say 'No mobile number on file' for a missing number, using only that person's own number", () => {
  assert.equal(nameWithMobile("Asha", "9000000003"), "Asha · 9000000003");
  for (const empty of [null, undefined, "", "  "]) assert.equal(nameWithMobile("Asha", empty), `Asha · ${NO_MOBILE_LABEL}`);
  assert.equal(emailWithMobile("v@example.com", "9000000005"), "v@example.com · 9000000005");
  for (const empty of [null, undefined, ""]) assert.equal(emailWithMobile("v@example.com", empty), `v@example.com · ${NO_MOBILE_LABEL}`);
});
