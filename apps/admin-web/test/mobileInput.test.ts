import test from "node:test";
import assert from "node:assert/strict";
import { INDIAN_MOBILE_MESSAGE } from "@recd/shared";
import { cleanMobile, mobileFieldError } from "../src/lib/mobileInput";

// Synthetic number - not a real person's.
const N = "9876543210";

test("accepted spellings pass the form check and clean to 10 digits", () => {
  for (const input of [N, `+91${N}`, `91${N}`, `0${N}`, "+91 98765 43210", "98765-43210", `  ${N}  `]) {
    assert.equal(mobileFieldError(input), null, input);
    assert.equal(cleanMobile(input), N, input);
  }
});

test("an empty field says the number is required", () => {
  assert.equal(mobileFieldError(""), "Mobile number is required");
  assert.equal(mobileFieldError("   "), "Mobile number is required");
});

test("invalid numbers get the standard message", () => {
  for (const input of ["98765", "abcdefghij", "5876543210", "98765432101", "+14155552671"]) {
    assert.equal(mobileFieldError(input), INDIAN_MOBILE_MESSAGE, input);
  }
});

test("cleanMobile refuses to invent a number from an invalid one", () => {
  assert.throws(() => cleanMobile("12345"), /valid 10-digit Indian mobile number/);
});
