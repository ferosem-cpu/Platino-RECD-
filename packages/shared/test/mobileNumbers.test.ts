import test from "node:test";
import assert from "node:assert/strict";
import {
  INDIAN_MOBILE_MESSAGE,
  createCustomerSchema,
  updateCustomerSchema,
  registerVendorSchema,
  createSiteContactSchema,
  updateSiteContactSchema,
  customerRegisterSchema,
  customerVerifySchema,
  requestOtpSchema,
  verifyOtpSchema,
  mobileStorageVariants,
  storedMobileMatches,
} from "../src";

// Synthetic numbers only - none of these belongs to a real person.
const N = "9876543210";

/** Every spelling of the same number the shared helper accepts. */
const ACCEPTED: Array<[string, string]> = [
  ["bare 10 digits", N],
  ["+91 prefix", `+91${N}`],
  ["91 prefix", `91${N}`],
  ["leading zero", `0${N}`],
  ["+91 with space", `+91 ${N}`],
  ["grouped with spaces", "98765 43210"],
  ["grouped with dashes", "98765-43210"],
  ["brackets and spaces", "(98765) 43210"],
  ["surrounding whitespace", `   ${N}  `],
  ["tab and newline around", `\t${N}\n`],
];

/** Things that must never be stored as a mobile number. */
const REJECTED: Array<[string, unknown]> = [
  ["empty string", ""],
  ["only spaces", "    "],
  ["too short", "98765"],
  ["9 digits", "987654321"],
  ["too long", "98765432101"],
  ["letters", "98765abcde"],
  ["symbols", "98765#4321"],
  ["starts with 5", "5876543210"],
  ["starts with 1", "1876543210"],
  ["+91 then too short", "+9198765"],
  ["+1 country code", "+14155552671"],
  ["number as a JS number", 9876543210],
  ["null", null],
];

const customer = (contactPhone: unknown) => ({ name: "Acme", contactName: "Asha", contactPhone });
const vendor = (contactPhone: unknown) => ({ name: "V", contactName: "Vik", contactEmail: "v@example.com", contactPhone });
const siteContact = (phone: unknown) => ({ name: "Security desk", phone });

const FLOWS: Array<[string, (phone: unknown) => unknown, (r: any) => string, (phone: unknown) => any]> = [
  ["createCustomerSchema", (p) => createCustomerSchema.safeParse(customer(p)), (r) => r.data.contactPhone, (p) => createCustomerSchema.safeParse(customer(p))],
  ["registerVendorSchema", (p) => registerVendorSchema.safeParse(vendor(p)), (r) => r.data.contactPhone, (p) => registerVendorSchema.safeParse(vendor(p))],
  ["createSiteContactSchema", (p) => createSiteContactSchema.safeParse(siteContact(p)), (r) => r.data.phone, (p) => createSiteContactSchema.safeParse(siteContact(p))],
  ["updateCustomerSchema", (p) => updateCustomerSchema.safeParse({ contactPhone: p }), (r) => r.data.contactPhone, (p) => updateCustomerSchema.safeParse({ contactPhone: p })],
  ["updateSiteContactSchema", (p) => updateSiteContactSchema.safeParse({ phone: p }), (r) => r.data.phone, (p) => updateSiteContactSchema.safeParse({ phone: p })],
  ["customerRegisterSchema", (p) => customerRegisterSchema.safeParse({ orderNumber: "ORD-1", phone: p }), (r) => r.data.phone, (p) => customerRegisterSchema.safeParse({ orderNumber: "ORD-1", phone: p })],
  ["customerVerifySchema", (p) => customerVerifySchema.safeParse({ orderNumber: "ORD-1", phone: p, code: "123456" }), (r) => r.data.phone, (p) => customerVerifySchema.safeParse({ orderNumber: "ORD-1", phone: p, code: "123456" })],
  ["requestOtpSchema", (p) => requestOtpSchema.safeParse({ phone: p }), (r) => r.data.phone, (p) => requestOtpSchema.safeParse({ phone: p })],
  ["verifyOtpSchema", (p) => verifyOtpSchema.safeParse({ phone: p, code: "123456" }), (r) => r.data.phone, (p) => verifyOtpSchema.safeParse({ phone: p, code: "123456" })],
];

for (const [flow, , read, parse] of FLOWS) {
  test(`${flow}: every accepted spelling is stored as the same 10 digits`, () => {
    for (const [label, input] of ACCEPTED) {
      const r = parse(input);
      assert.equal(r.success, true, `${label}: ${JSON.stringify(input)}`);
      assert.equal(read(r), N, label);
    }
  });

  test(`${flow}: invalid mobile numbers are rejected with the standard message`, () => {
    for (const [label, input] of REJECTED) {
      const r = parse(input);
      assert.equal(r.success, false, `${label} should be rejected`);
      const messages = JSON.stringify(r.error.flatten());
      assert.ok(messages.includes(INDIAN_MOBILE_MESSAGE), `${label}: ${messages}`);
    }
  });
}

test("a missing mobile number is rejected where the number is mandatory", () => {
  const mandatory = [
    createCustomerSchema.safeParse({ name: "Acme", contactName: "Asha" }),
    registerVendorSchema.safeParse({ name: "V", contactName: "Vik", contactEmail: "v@example.com" }),
    createSiteContactSchema.safeParse({ name: "Security desk" }),
    customerRegisterSchema.safeParse({ orderNumber: "ORD-1" }),
    requestOtpSchema.safeParse({}),
  ];
  for (const r of mandatory) {
    assert.equal(r.success, false);
    assert.ok(JSON.stringify((r as any).error.flatten()).includes(INDIAN_MOBILE_MESSAGE));
  }
});

test("updates: the number is optional (leave it unchanged) but never accepted when invalid", () => {
  assert.equal(updateCustomerSchema.safeParse({ contactName: "New name" }).success, true);
  assert.equal(updateSiteContactSchema.safeParse({ name: "New name" }).success, true, "a legacy contact can be renamed");
  const noPhone = updateSiteContactSchema.parse({ name: "New name" });
  assert.equal("phone" in noPhone && noPhone.phone !== undefined, false, "no phone invented");
  assert.equal(updateCustomerSchema.safeParse({ contactPhone: "" }).success, false, "an update cannot blank the number");
  assert.equal(updateSiteContactSchema.safeParse({ phone: "" }).success, false);
});

test("updateCustomerSchema accepts a contactId to say which contact is edited", () => {
  assert.equal(updateCustomerSchema.parse({ contactId: "c1", contactName: "X" }).contactId, "c1");
  assert.equal(updateCustomerSchema.safeParse({ contactId: "" }).success, false);
});

test("the vendor mobile number is mandatory for new vendors", () => {
  assert.equal(registerVendorSchema.safeParse({ name: "V", contactName: "Vik", contactEmail: "v@example.com" }).success, false);
  assert.equal(registerVendorSchema.safeParse(vendor(undefined)).success, false);
});

test("mobileStorageVariants lists the legacy formats; storedMobileMatches compares after normalising", () => {
  assert.deepEqual(mobileStorageVariants(N), [N, `+91${N}`, `91${N}`, `0${N}`]);
  for (const legacy of [N, `+91${N}`, `91${N}`, `0${N}`, `+91 98765 43210`, " 98765-43210 "]) {
    assert.equal(storedMobileMatches(legacy, N), true, legacy);
  }
  for (const other of [null, undefined, "", "abc", "9876543211", "+14155552671", "12345"]) {
    assert.equal(storedMobileMatches(other as any, N), false, String(other));
  }
});
