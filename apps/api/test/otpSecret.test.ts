// OTP hashing key selection (Requirement 3). Pure functions; no database, no network. Secrets here are throwaway test strings.
process.env.JWT_SECRET = "test-secret";
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { otpHmacSecret } from "../src/lib/otpSecret";
import { hashLoginOtp, verifyLoginOtpHash } from "../src/lib/loginOtp";
import { hashOtpCode, verifyOtpCode } from "../src/lib/publicOtp";

afterEach(() => { delete process.env.OTP_HMAC_SECRET; });

test("without OTP_HMAC_SECRET the key is JWT_SECRET, exactly as before (no deployment is broken)", () => {
  assert.equal(otpHmacSecret(), "test-secret");
  const h = hashLoginOtp("id1", "u1", "123456");
  assert.ok(verifyLoginOtpHash("id1", "u1", "123456", h));
});

test("with OTP_HMAC_SECRET set, codes are keyed with it and hashes made under the old key no longer verify (pending codes are invalidated)", () => {
  const before = hashLoginOtp("id1", "u1", "123456");
  const beforePublic = hashOtpCode("id1", "9876543210", "123456");
  process.env.OTP_HMAC_SECRET = "a-dedicated-otp-secret-value";
  assert.equal(otpHmacSecret(), "a-dedicated-otp-secret-value");
  assert.equal(verifyLoginOtpHash("id1", "u1", "123456", before), false);
  assert.equal(verifyOtpCode("id1", "9876543210", "123456", beforePublic), false);
  const after = hashLoginOtp("id1", "u1", "123456");
  assert.notEqual(after, before);
  assert.ok(verifyLoginOtpHash("id1", "u1", "123456", after));
  assert.ok(verifyOtpCode("id1", "9876543210", "123456", hashOtpCode("id1", "9876543210", "123456")));
});

test("a too-short OTP_HMAC_SECRET is refused rather than silently used or silently ignored", () => {
  process.env.OTP_HMAC_SECRET = "short";
  assert.throws(() => otpHmacSecret(), /shorter than 16/);
  assert.throws(() => hashLoginOtp("id1", "u1", "123456"));
  process.env.OTP_HMAC_SECRET = "";
  assert.equal(otpHmacSecret(), "test-secret", "an empty value counts as unset");
});

test("the error never contains the secret value", () => {
  process.env.OTP_HMAC_SECRET = "tiny";
  try { otpHmacSecret(); assert.fail("should throw"); } catch (e) { assert.ok(!String((e as Error).message).includes("tiny")); }
});
