// Regression: the web login page and the mobile LoginScreen must start with empty credential fields.
// These are source-level checks (the repo has no component-test runner); they read the files as text.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(__dirname, "../../..");
const web = readFileSync(resolve(root, "apps/admin-web/src/app/login/page.tsx"), "utf8");
const mobile = readFileSync(resolve(root, "apps/mobile/src/screens/LoginScreen.tsx"), "utf8");

/** Initial values passed to useState for the given state variables. */
const initial = (src: string, name: string) =>
  src.match(new RegExp(String.raw`const \[${name}, set\w+\] = useState\(([^)]*)\)`))?.[1];

test("web login starts with empty staff and customer credential fields", () => {
  for (const name of ["email", "password", "orderNumber", "phone"]) assert.equal(initial(web, name), '""', `web ${name}`);
});

test("mobile login starts with empty email and password", () => {
  for (const name of ["email", "password"]) assert.equal(initial(mobile, name), '""', `mobile ${name}`);
});

test("no development credentials are left in either login file, and sign-in still posts the typed values", () => {
  for (const [label, src] of [["web", web], ["mobile", mobile]] as const) {
    assert.doesNotMatch(src, /platino\.example|changeme/i, label);
  }
  assert.match(web, /body: JSON\.stringify\(\{ email, password \}\)/);
  assert.match(mobile, /loginWithPassword\(email, password\)/);
});
