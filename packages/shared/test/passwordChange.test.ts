import test from "node:test";
import assert from "node:assert/strict";
import { PASSWORD_CHANGE_REQUIRED_CODE, isPasswordChangeRequired } from "../src";

test("the forced-change code is the one string both apps and the API agree on", () => {
  assert.equal(PASSWORD_CHANGE_REQUIRED_CODE, "PASSWORD_CHANGE_REQUIRED");
});

test("it recognises a response body and an ApiRequestError-shaped object, and nothing else", () => {
  assert.equal(isPasswordChangeRequired({ error: "x", code: "PASSWORD_CHANGE_REQUIRED" }), true);
  assert.equal(isPasswordChangeRequired({ status: 403, body: { code: "PASSWORD_CHANGE_REQUIRED" } }), true);
  assert.equal(isPasswordChangeRequired({ status: 403, body: { code: "OTHER" } }), false);
  assert.equal(isPasswordChangeRequired({ status: 401, body: { code: "OTHER" } }), false);
  assert.equal(isPasswordChangeRequired({ code: "OTP_DELIVERY_FAILED" }), false);
  for (const v of [null, undefined, "PASSWORD_CHANGE_REQUIRED", 403, {}, []]) assert.equal(isPasswordChangeRequired(v), false);
});
