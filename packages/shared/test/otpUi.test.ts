import test from "node:test";
import assert from "node:assert/strict";
import {
  LOGIN_OTP_POLICY,
  PUBLIC_OTP,
  canResend,
  otpErrorText,
  otpExpiryText,
  otpRequestedNotice,
  resendLabel,
  tickCooldown,
} from "../src/index";

test("the login OTP policy keeps the 10-minute life, 30 s resend and the public flow's 5 minutes", () => {
  assert.equal(LOGIN_OTP_POLICY.EXPIRY_SECONDS, 600);
  assert.equal(LOGIN_OTP_POLICY.RESEND_COOLDOWN_SECONDS, PUBLIC_OTP.RESEND_COOLDOWN_SECONDS);
  assert.equal(LOGIN_OTP_POLICY.MAX_ATTEMPTS_PER_CODE, 5);
  assert.equal(PUBLIC_OTP.EXPIRY_SECONDS, 300);
  assert.ok(LOGIN_OTP_POLICY.MAX_FAILED_PER_HOUR >= LOGIN_OTP_POLICY.MAX_ATTEMPTS_PER_CODE);
});

test("expiry text is plain English for both flows", () => {
  assert.equal(otpExpiryText(600), "10 minutes");
  assert.equal(otpExpiryText(300), "5 minutes");
  assert.equal(otpExpiryText(60), "1 minute");
  assert.equal(otpExpiryText(45), "45 seconds");
  assert.equal(otpExpiryText(0), "a few minutes");
  assert.equal(otpExpiryText(Number.NaN), "a few minutes");
});

test("resend control: disabled while the cooldown runs, counts down, enabled at zero, never below zero", () => {
  assert.equal(resendLabel(30), "Resend code in 30s");
  assert.equal(resendLabel(1), "Resend code in 1s");
  assert.equal(resendLabel(0), "Resend code");
  assert.equal(canResend(5), false);
  assert.equal(canResend(0), true);
  assert.equal(canResend(0, true), false, "disabled while a request is in flight");
  let left = LOGIN_OTP_POLICY.RESEND_COOLDOWN_SECONDS;
  let ticks = 0;
  while (!canResend(left)) { left = tickCooldown(left); ticks++; }
  assert.equal(ticks, 30);
  assert.equal(tickCooldown(0), 0);
});

test("after a request the notice repeats the server's wording and the expiry - and never says a phone received it", () => {
  const n = otpRequestedNotice({ message: "If those details match an active account, a one-time code has been sent to its registered mobile number on WhatsApp.", expiresInSeconds: 600 }, 600);
  assert.match(n, /^If those details match/);
  assert.match(n, /valid for 10 minutes\.$/);
  assert.match(otpRequestedNotice({}, 600), /valid for 10 minutes/, "falls back to the shared policy");
});

test("error wording: rate limit, waiting before resend, delivery failure, incorrect or expired code", () => {
  assert.match(otpErrorText("request", { status: 429, message: "Please wait 12s before requesting another code.", retryAfterSeconds: 12 }), /wait 12s/);
  assert.match(otpErrorText("request", { status: 429, message: "Too many code requests. Please try again later.", retryAfterSeconds: 1800 }), /Too many attempts\. Try again in 30 minutes\./);
  assert.match(otpErrorText("request", { status: 503, message: "We could not send the code right now. Please try again in a few minutes." }), /could not send/);
  assert.doesNotMatch(otpErrorText("request", { status: 503, message: "" }), /\bsent to\b/i);
  assert.match(otpErrorText("verify", { status: 401, message: "Invalid or expired code" }), /incorrect or has expired/);
  assert.match(otpErrorText("verify", { status: 400 }), /incorrect or has expired/);
  assert.match(otpErrorText("verify", { status: 429 }), /Too many attempts/);
  assert.equal(otpErrorText("request", {}), "Could not request a code.");
});
