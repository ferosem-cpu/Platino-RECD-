import test from "node:test";
import assert from "node:assert/strict";
import { PERMISSION_KEY, ROLE_KEY, PHONE_OTP_DENIED_PERMISSION_KEYS, PHONE_OTP_DENIED_ROLE_KEYS, isPhoneOtpLoginAllowed } from "../src";

const role = (key: string, perms: string[] = []) => ({ role: { key, permissions: perms.map((p) => ({ permission: { key: p } })) } });

test("the administrative roles are denied by key, even with no permission list loaded", () => {
  assert.deepEqual([...PHONE_OTP_DENIED_ROLE_KEYS].sort(), [ROLE_KEY.MANAGEMENT, ROLE_KEY.OWNER_ADMIN, ROLE_KEY.SUPER_ADMIN].sort());
  for (const k of PHONE_OTP_DENIED_ROLE_KEYS) assert.equal(isPhoneOtpLoginAllowed(role(k)), false, k);
});

test("any role holding an administrative permission is denied, whatever it is called", () => {
  assert.deepEqual([...PHONE_OTP_DENIED_PERMISSION_KEYS].sort(), [PERMISSION_KEY.MANAGE_REGIONS, PERMISSION_KEY.MANAGE_SETTINGS, PERMISSION_KEY.MANAGE_USERS, PERMISSION_KEY.MANAGE_WARRANTY].sort());
  for (const p of PHONE_OTP_DENIED_PERMISSION_KEYS) assert.equal(isPhoneOtpLoginAllowed(role("renamed_admin", [PERMISSION_KEY.VIEW_SITE_STATUS, p])), false, p);
});

test("every non-administrative built-in role keeps phone login; an unestablished role never gets it", () => {
  for (const k of Object.values(ROLE_KEY)) {
    if ((PHONE_OTP_DENIED_ROLE_KEYS as readonly string[]).includes(k)) continue;
    assert.equal(isPhoneOtpLoginAllowed(role(k, [PERMISSION_KEY.VIEW_SITE_STATUS, PERMISSION_KEY.RAISE_COMPLAINT])), true, k);
  }
  assert.equal(isPhoneOtpLoginAllowed(undefined), false);
  assert.equal(isPhoneOtpLoginAllowed({ role: null }), false);
});
