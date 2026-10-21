import test from "node:test";
import assert from "node:assert/strict";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
import {
  checkOtpAttemptable, decideOtpRequest, generateOtpCode, generateSessionToken,
  hashOtpCode, hashSessionToken, verifyOtpCode,
} from "../src/lib/publicOtp";
import { buildWhatsAppOtpPayload, devEchoAllowed, getOtpDelivery } from "../src/lib/otpDelivery";

test("OTP codes are 6 digits", () => {
  for (let i = 0; i < 50; i++) assert.match(generateOtpCode(), /^\d{6}$/);
});

test("hash verifies only the right code, phone and id", () => {
  const h = hashOtpCode("id1", "9876543210", "123456");
  assert.ok(verifyOtpCode("id1", "9876543210", "123456", h));
  assert.ok(!verifyOtpCode("id1", "9876543210", "654321", h));
  assert.ok(!verifyOtpCode("id1", "9876543211", "123456", h));
  assert.ok(!verifyOtpCode("id2", "9876543210", "123456", h));
});

test("session tokens hash deterministically and are unique", () => {
  const a = generateSessionToken(), b = generateSessionToken();
  assert.notEqual(a.token, b.token);
  assert.equal(hashSessionToken(a.token), a.hash);
});

test("attemptable states", () => {
  const now = new Date("2026-10-07T10:00:00Z");
  const base = { expiresAt: new Date("2026-10-07T10:05:00Z"), attempts: 0, verifiedAt: null };
  assert.equal(checkOtpAttemptable(base, now), "ok");
  assert.equal(checkOtpAttemptable({ ...base, expiresAt: new Date("2026-10-07T09:59:00Z") }, now), "expired");
  assert.equal(checkOtpAttemptable({ ...base, attempts: 5 }, now), "locked");
  assert.equal(checkOtpAttemptable({ ...base, verifiedAt: now }, now), "already_verified");
});

test("request throttling: cooldown and hourly limits", () => {
  const ok = { phoneLastHour: 0, serialLastHour: 0, ipLastHour: 0, secondsSinceLastForPhone: null };
  assert.deepEqual(decideOtpRequest(ok), { allowed: true });
  const cd = decideOtpRequest({ ...ok, secondsSinceLastForPhone: 10 });
  assert.ok(!cd.allowed && cd.reason === "cooldown" && cd.retryAfterSeconds === 20);
  assert.ok(!decideOtpRequest({ ...ok, phoneLastHour: 5 }).allowed);
  assert.ok(!decideOtpRequest({ ...ok, serialLastHour: 10 }).allowed);
  assert.ok(!decideOtpRequest({ ...ok, ipLastHour: 20 }).allowed);
});

test("the spoofable x-forwarded-for helper is gone: the client address comes from req.ip, which Express derives only via TRUST_PROXY", () => {
  assert.equal((require("../src/lib/publicOtp") as Record<string, unknown>).clientIp, undefined);
});

test("WhatsApp payload targets +91 number with code in body and button", () => {
  const p = buildWhatsAppOtpPayload("9876543210", "123456", "recd_otp", "en") as any;
  assert.equal(p.to, "919876543210");
  assert.equal(p.type, "template");
  assert.match(JSON.stringify(p), /123456/);
});

test("delivery selection: WhatsApp when configured; the dev channel ONLY with the explicit opt-in and never hosted", () => {
  assert.equal(getOtpDelivery({ NODE_ENV: "production" } as any), null);
  assert.equal(getOtpDelivery({ NODE_ENV: "production", VERCEL_ENV: "production" } as any), null);
  assert.equal(getOtpDelivery({ NODE_ENV: "production", WHATSAPP_ACCESS_TOKEN: "t", WHATSAPP_PHONE_NUMBER_ID: "p" } as any)?.name, "whatsapp");
  assert.equal(getOtpDelivery({ NODE_ENV: "development" } as any), null, "development alone no longer enables a fake channel");
  assert.equal(getOtpDelivery({ NODE_ENV: "development", OTP_DEV_ECHO: "1" } as any)?.name, "dev");
  assert.equal(getOtpDelivery({ NODE_ENV: "development", OTP_DEV_ECHO: "1", VERCEL: "1" } as any), null);
  assert.ok(!devEchoAllowed({ NODE_ENV: "development" } as any));
  assert.ok(devEchoAllowed({ NODE_ENV: "development", PUBLIC_OTP_DEV_ECHO: "1" } as any));
  assert.ok(!devEchoAllowed({ NODE_ENV: "development", VERCEL_ENV: "production", PUBLIC_OTP_DEV_ECHO: "1" } as any));
});
