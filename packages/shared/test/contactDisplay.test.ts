import test from "node:test";
import assert from "node:assert/strict";
import {
  NO_MOBILE_LABEL,
  SERIAL_MISSING_LABEL,
  mobileOrNone,
  serialOrPending,
  siteContactLines,
  telHref,
  unitLines,
  unitSerialsSummary,
} from "../src";

test("a missing, blank or legacy value gets the one standard wording - never another person's number or another unit's serial", () => {
  for (const v of [null, undefined, "", "   "]) {
    assert.equal(mobileOrNone(v), NO_MOBILE_LABEL);
    assert.equal(serialOrPending(v), SERIAL_MISSING_LABEL);
  }
  assert.equal(mobileOrNone(" 9876543210 "), "9876543210");
  assert.equal(serialOrPending(" SN-1 "), "SN-1");
});

test("unitLines: serial and model per unit, legacy units without a serial are flagged, retired units are marked", () => {
  const lines = unitLines([
    { id: "a", serialNo: "SN-1", status: "active", product: { name: "RECD", model: "250" } },
    { id: "b", serialNo: null, status: "active" },
    { id: "c", serialNo: "SN-3", status: "retired" },
  ]);
  assert.deepEqual(lines.map((l) => [l.id, l.serial, l.hasSerial, l.model, l.retired]), [
    ["a", "SN-1", true, "RECD (250)", false],
    ["b", SERIAL_MISSING_LABEL, false, null, false],
    ["c", "SN-3", true, null, true],
  ]);
});

test("unitLines / unitSerialsSummary tolerate a response with no units at all (older API, no RECD recorded)", () => {
  assert.deepEqual(unitLines(undefined), []);
  assert.deepEqual(unitLines(null), []);
  assert.equal(unitSerialsSummary(undefined), "No RECD recorded");
  assert.equal(unitSerialsSummary([]), "No RECD recorded");
  assert.equal(unitSerialsSummary([{ id: "a", serialNo: "SN-1" }, { id: "b", serialNo: null }, { id: "c", serialNo: "SN-3" }]), `SN-1, ${SERIAL_MISSING_LABEL}, SN-3`);
});

test("siteContactLines: the Site POC first, then each site contact, each labelled by its own record; a person without a number says so", () => {
  const lines = siteContactLines({
    sitePocName: "Ravi",
    sitePocNumber: "9876543210",
    contacts: [
      { id: "1", name: "Security desk", role: "Security", phone: "9123456780" },
      { id: "2", name: "Store keeper", role: null, phone: null },
    ],
  });
  assert.deepEqual(lines.map((l) => [l.heading, l.name, l.phone, l.hasPhone]), [
    ["Site POC", "Ravi", "9876543210", true],
    ["Site contact · Security", "Security desk", "9123456780", true],
    ["Site contact", "Store keeper", NO_MOBILE_LABEL, false],
  ]);
  assert.deepEqual(lines.map((l) => l.key), ["site-poc", "contact-1", "contact-2"]);
});

test("siteContactLines: a POC with a name but no number is shown with the standard text, not skipped and not given a contact's number", () => {
  const lines = siteContactLines({ sitePocName: "Ravi", sitePocNumber: null, contacts: [{ id: "1", name: "Desk", phone: "9123456780" }] });
  assert.equal(lines[0].phone, NO_MOBILE_LABEL);
  assert.equal(lines[0].hasPhone, false);
  assert.equal(lines[1].phone, "9123456780");
});

test("siteContactLines: nothing recorded (or no site at all) is an empty list", () => {
  assert.deepEqual(siteContactLines(null), []);
  assert.deepEqual(siteContactLines({}), []);
  assert.deepEqual(siteContactLines({ sitePocName: "  ", sitePocNumber: "", contacts: [] }), []);
});

test("telHref: only a plain number becomes a call link; anything else is not linkable", () => {
  assert.equal(telHref("9876543210"), "tel:9876543210");
  assert.equal(telHref("+91 98765-43210"), "tel:+919876543210");
  assert.equal(telHref(null), null);
  assert.equal(telHref(NO_MOBILE_LABEL), null);
  assert.equal(telHref("12"), null);
  assert.equal(telHref("javascript:alert(1)"), null);
});
