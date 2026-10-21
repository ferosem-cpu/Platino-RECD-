// Users page (Add user / Edit user) phone field: the form uses the SHARED rule, so every spelling the server accepts is
// accepted by the form, invalid numbers are refused with the standard message, and API errors are shown without the
// literal quotation marks the API client wraps around plain-string errors. Source-level checks for the screen itself
// (the repo has no component-test runner); not a browser check.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { INDIAN_MOBILE_MESSAGE } from "@recd/shared";
import { apiErrorMessage } from "../src/lib/apiError";
import { cleanMobile, mobileFieldError } from "../src/lib/mobileInput";

const page = readFileSync(resolve(__dirname, "../src/app/users/page.tsx"), "utf8");

const ACCEPTED = ["9876543210", "98765 43210", "98765-43210", "+91 98765-43210", "+919876543210", "919876543210", "09876543210", "(98765) 43210", "  9876543210  "];
const REJECTED = ["12345", "5876543210", "98765abcde", "+14155552671", "98765432101", "987654321", "+91 12345 67890"];

test("the staff form accepts every spelling the server accepts and cleans it to 10 digits", () => {
  for (const v of ACCEPTED) {
    assert.equal(mobileFieldError(v), null, v);
    assert.equal(cleanMobile(v), "9876543210", v);
  }
});

test("the staff form rejects invalid numbers with the standard message, and an empty field says it is required", () => {
  for (const v of REJECTED) assert.equal(mobileFieldError(v), INDIAN_MOBILE_MESSAGE, v);
  assert.equal(mobileFieldError(""), "Mobile number is required");
  assert.equal(mobileFieldError("   "), "Mobile number is required");
});

test("the Add user and Edit user phone inputs no longer carry a browser pattern that is stricter than the server", () => {
  assert.doesNotMatch(page, /pattern=/);
  assert.match(page, /type="tel"/);
  assert.match(page, /mobileFieldError\(form\.phone\)/);
  assert.match(page, /mobileFieldError\(editForm\.phone\)/);
  assert.match(page, /cleanMobile\(form\.phone\)/);
  assert.match(page, /cleanMobile\(editForm\.phone\)/);
});

test("every error on the Users page goes through the API error helper (no raw err.message)", () => {
  assert.doesNotMatch(page, /err instanceof Error \? err\.message/);
  for (const fallback of ["Failed to add user", "Failed to update user", "Failed to deactivate user", "Failed to activate user", "Failed to reset password"]) {
    // since R10 the page uses userAdminErrorMessage, which wraps apiErrorMessage (adds the status-aware lead for 403 / 401)
    assert.match(page, new RegExp(`(apiErrorMessage|userAdminErrorMessage)\\(err, "${fallback}"\\)`));
  }
});

test("the duplicate-phone message reads naturally, without surrounding quotation marks", () => {
  const raw = new Error(JSON.stringify("That mobile number is already used by another user")); // what api() throws for a string error
  const shown = apiErrorMessage(raw, "Failed to add user");
  assert.equal(shown, "That mobile number is already used by another user");
  assert.doesNotMatch(shown, /^"|"$/);
  // validation errors keep their field wording
  const zod = new Error(JSON.stringify({ formErrors: [], fieldErrors: { phone: [INDIAN_MOBILE_MESSAGE] } }));
  assert.equal(apiErrorMessage(zod, "x"), `phone: ${INDIAN_MOBILE_MESSAGE}`);
});
