// Forced password change in the web and mobile apps (Requirement 3). The API is the security boundary (apps/api/test/forcedPasswordChange.test.ts);
// these check that the apps recognise PASSWORD_CHANGE_REQUIRED and take the person to the change-password screen WITHOUT retrying calls that can
// only fail. The web client is exercised for real (fetch and window are stubbed); the screens have no component runner, so they are source-level checks.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(__dirname, "../../..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8");

/* eslint-disable @typescript-eslint/no-explicit-any */
function fakeBrowser(pathname: string) {
  const store = new Map<string, string>([["recd_token", "stored-token"]]);
  const location = { pathname, href: "" };
  (globalThis as any).window = { location, localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) } };
  return { store, location };
}
function answer(status: number, body: unknown) {
  const calls: string[] = [];
  (globalThis as any).fetch = async (url: string) => { calls.push(String(url)); return new Response(JSON.stringify(body), { status }); };
  return calls;
}

test("web client: a 403 PASSWORD_CHANGE_REQUIRED sends the person to /change-password once, keeps the token, and still rejects the call", async () => {
  const { api, ApiRequestError } = await import("../src/lib/apiClient");
  const { store, location } = fakeBrowser("/orders");
  answer(403, { error: "You must change your password before continuing", code: "PASSWORD_CHANGE_REQUIRED" });
  await assert.rejects(() => api("/orders"), (e: unknown) => e instanceof ApiRequestError && e.status === 403);
  assert.equal(location.href, "/change-password");
  assert.equal(store.get("recd_token"), "stored-token", "the token is needed to complete the change");
});

test("web client: already on the change-password screen (or the login page) there is no redirect loop", async () => {
  const { api } = await import("../src/lib/apiClient");
  for (const path of ["/change-password", "/login"]) {
    const { location } = fakeBrowser(path);
    answer(403, { error: "x", code: "PASSWORD_CHANGE_REQUIRED" });
    await assert.rejects(() => api("/auth/change-password", { method: "POST" }));
    assert.equal(location.href, "", path);
  }
});

test("web client: other 403s (no permission) are NOT treated as a forced change, and a 401 still ends the session", async () => {
  const { api, setToken } = await import("../src/lib/apiClient");
  const { location } = fakeBrowser("/orders");
  answer(403, { error: "Forbidden" });
  await assert.rejects(() => api("/orders"));
  assert.equal(location.href, "");
  const b = fakeBrowser("/orders");
  setToken("t");
  answer(401, { error: "Your session is no longer valid - please sign in again" });
  await assert.rejects(() => api("/orders"));
  assert.equal(b.location.href, "/login");
  assert.equal(b.store.has("recd_token"), false);
});

test("web session loader: a flagged account stops after /auth/me - no settings call - and the guard routes it to /change-password", () => {
  const ctx = read("apps/admin-web/src/components/AuthContext.tsx");
  const afterMe = ctx.slice(ctx.indexOf('api<UserSession>("/auth/me")'));
  assert.ok(afterMe.indexOf("if (data.mustChangePassword) return;") > 0 && afterMe.indexOf("if (data.mustChangePassword) return;") < afterMe.indexOf('api<{ themeKey'), "settings are not requested for a flagged account");
  const guard = read("apps/admin-web/src/components/AuthGuard.tsx");
  assert.match(guard, /if \(user\.mustChangePassword\) \{\s*if \(pathname !== "\/change-password"\) router\.push\("\/change-password"\)/);
});

test("web change-password page: stores the fresh token the server returns, then reloads the session; failure keeps the user on the page", () => {
  const page = read("apps/admin-web/src/app/change-password/page.tsx");
  assert.match(page, /if \(result\?\.token\) setToken\(result\.token\)/);
  assert.match(page, /await refresh\(\)/);
  assert.match(page, /catch \(err\) \{\s*setError\(apiErrorMessage\(err, "Failed to change password"\)\)/);
});

test("mobile: sign-in (password and OTP) asks /auth/me and routes a flagged account to ChangePassword only; no field screen is mounted", () => {
  const auth = read("apps/mobile/src/context/AuthContext.tsx");
  assert.match(auth, /async \(token: string, signedIn: AuthUser\)/);
  assert.match(auth, /api<\{ mustChangePassword\?: boolean \}>\("\/auth\/me"\)/);
  assert.match(auth, /isPasswordChangeRequired\(err\)/);
  assert.equal((auth.match(/await startSession\(/g) ?? []).length, 2, "both the password and the OTP sign-in go through startSession");
  assert.doesNotMatch(auth, /await setToken\(result\.token\);\s*\n\s*setUser\(result\.user\)/, "no sign-in sets the user without checking the flag");
  const nav = read("apps/mobile/src/navigation/RootNavigator.tsx");
  const branch = nav.slice(nav.indexOf("passwordChangeRequired ? ("), nav.indexOf("isFieldRole(user.role) ? ("));
  assert.match(branch, /name="ChangePassword"/);
  assert.doesNotMatch(branch, /MySites|MyOrders/);
});

test("mobile change-password: validates like the API, shows the server's wording, and the fresh token replaces the stored one", () => {
  const screen = read("apps/mobile/src/screens/ChangePasswordScreen.tsx");
  assert.match(screen, /MIN_PASSWORD_LENGTH/);
  assert.match(screen, /await changePassword\(currentPassword, newPassword\)/);
  const auth = read("apps/mobile/src/context/AuthContext.tsx");
  assert.match(auth, /"\/auth\/change-password"/);
  assert.match(auth, /if \(result\.token\) await setToken\(result\.token\)/);
  assert.match(auth, /setPasswordChangeRequired\(false\)/);
  assert.ok(auth.indexOf("setPasswordChangeRequired(false)") > auth.indexOf("await api<{ ok: boolean; token?: string }>"), "the flag is cleared only after the API call succeeded");
});

test("the API's code and the apps' code are the same string", () => {
  const mw = read("apps/api/src/middleware/auth.ts");
  assert.match(mw, /export const PASSWORD_CHANGE_REQUIRED = "PASSWORD_CHANGE_REQUIRED"/);
});
