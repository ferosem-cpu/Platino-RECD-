// Web and mobile OTP screens. The repo has no component-test runner, so these are source-level checks of the
// resend / expiry / failure wiring (reading the files as text), on top of the unit tests of the shared helpers
// they use (packages/shared/test/otpUi.test.ts). They do NOT replace trying the screens in a browser or on a phone.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(__dirname, "../../..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8");
const web = read("apps/admin-web/src/app/login/page.tsx");
const publicPage = read("apps/admin-web/src/app/report-issue/page.tsx");
const mobile = read("apps/mobile/src/screens/OtpScreens.tsx");
const mobileAuth = read("apps/mobile/src/context/AuthContext.tsx");

test("web customer login: a resend control with a countdown, disabled until the server's cooldown has passed", () => {
  assert.match(web, /canResend\(cooldown, customerLoading\)/);
  assert.match(web, /resendLabel\(cooldown\)/);
  assert.match(web, /setCooldown\(result\.resendAfterSeconds \?\? LOGIN_OTP_POLICY\.RESEND_COOLDOWN_SECONDS\)/, "cooldown comes from the server's answer");
  assert.match(web, /tickCooldown/);
  assert.match(web, /Code valid for \{otpExpiryText\(expiresInSeconds\)\}/, "the expiry is shown");
  assert.match(web, /status === 429/, "a server 429 restarts the countdown");
});

test("web customer login: it no longer talks about email and never shows a 'sent' notice when the request failed", () => {
  assert.doesNotMatch(web, /emailed|by email|delivered by email/i);
  assert.match(web, /WhatsApp/);
  // The notice is set only after a successful response (inside the try, after the awaited call).
  const request = web.slice(web.indexOf("async function requestCustomerOtp"), web.indexOf("async function handleCustomerRequestOtp"));
  assert.ok(request.indexOf("setOtpNotice(") > request.indexOf('await api<'), "notice only after the API call succeeded");
  assert.ok(request.indexOf("catch (err)") > request.indexOf("setOtpNotice("));
  assert.doesNotMatch(request.slice(request.indexOf("catch (err)")), /setOtpNotice\(|setOtpSent\(true\)/, "a failure sets no success notice and does not advance to the code screen");
});

test("web customer login: error messages go through the shared wording (rate limit, delivery failure, wrong/expired code)", () => {
  assert.match(web, /otpErrorText\("request"/);
  assert.match(web, /otpErrorText\("verify"/);
});

test("the development code box is labelled as development and only shown when the API returned one", () => {
  assert.match(web, /\{otpMessage && \(/);
  assert.match(web, /Development mode - nothing was sent to a phone/);
});

test("public complaint page keeps its resend countdown and now shows the code lifetime", () => {
  assert.match(publicPage, /canResend\(cooldown, loading\)/);
  assert.match(publicPage, /resendLabel\(cooldown\)/);
  assert.match(publicPage, /valid for \{otpExpiryText\(expiresIn\)\}/);
  assert.match(publicPage, /retryAfterSeconds/);
});

test("mobile app: request and verify use the registered number; resend, countdown and expiry text are present", () => {
  assert.match(mobile, /requestOtp\(phone\)/);
  assert.match(mobile, /verifyOtp\(phone, code\)/);
  assert.match(mobile, /handleResend/);
  assert.match(mobile, /resendLabel\(cooldown\)/);
  assert.match(mobile, /canResend\(cooldown, loading\)/);
  assert.match(mobile, /Code valid for \{otpExpiryText\(expiresIn\)\}/);
  assert.match(mobile, /WhatsApp/);
  assert.doesNotMatch(mobile, /email/i, "no screen text promises an email any more");
  assert.match(mobileAuth, /api<OtpRequestResponse>\("\/auth\/otp\/request"/);
});

test("mobile app: a development code can only ever be displayed in a development build", () => {
  const uses = mobile.split("\n").filter((l) => /devCode/.test(l) && /Text|\{.*devCode.*\}/.test(l) && !/useState|setDevCode|result\?\.devCode|r\.devCode/.test(l));
  assert.ok(uses.length >= 1);
  for (const line of uses) assert.match(line, /__DEV__/, `devCode shown without __DEV__: ${line.trim()}`);
});
