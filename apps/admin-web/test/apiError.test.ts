import test from "node:test";
import assert from "node:assert/strict";
import { apiErrorMessage, withoutFieldPrefix } from "../src/lib/apiError";

test("unwraps the JSON-quoted string errors the API client throws", () => {
  const err = new Error(JSON.stringify("Serial number already registered: SN-1"));
  assert.equal(apiErrorMessage(err, "fallback"), "Serial number already registered: SN-1");
});

test("flattens zod validation errors into one readable line", () => {
  const err = new Error(JSON.stringify({ formErrors: ["Bad body"], fieldErrors: { unitIds: ["A unit can only be listed once"] } }));
  assert.equal(apiErrorMessage(err, "fallback"), "Bad body; unitIds: A unit can only be listed once");
});

test("keeps plain messages and falls back for non-errors", () => {
  assert.equal(apiErrorMessage(new Error("Request failed: 500"), "fallback"), "Request failed: 500");
  assert.equal(apiErrorMessage("boom", "fallback"), "fallback");
  assert.equal(apiErrorMessage(new Error(""), "fallback"), "fallback");
});

test("withoutFieldPrefix removes only the named field prefix and keeps every other detail", () => {
  const err = new Error(JSON.stringify({ formErrors: [], fieldErrors: { recdSerials: ["Use letters, digits and - _ / . only"], quantity: ["Too small"] } }));
  const msg = apiErrorMessage(err, "fallback");
  assert.equal(msg, "recdSerials: Use letters, digits and - _ / . only; quantity: Too small");
  assert.equal(withoutFieldPrefix(msg, "recdSerials"), "Use letters, digits and - _ / . only; quantity: Too small");
  assert.equal(withoutFieldPrefix("Serial number already registered: SN-1", "recdSerials"), "Serial number already registered: SN-1");
  assert.equal(withoutFieldPrefix("Failed to create order", "recdSerials"), "Failed to create order");
});
