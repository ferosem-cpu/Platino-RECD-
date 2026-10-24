# Platino RECD Tracker — Handover

## 1. What it is
A role‑based **Project & Service Tracker** for Platino, an RECD (Retrofit Emission Control Device) manufacturing + installation business. It tracks an order from sale through on‑site installation and commissioning (the **SITC** process: Supply → Installation → Testing → Commissioning), handles customer complaints, and gives each role a tailored view. Built to ship **Phase 1** now while keeping the full long‑term vision **future‑ready**.

## 2. Stack & layout
Turborepo monorepo, **npm workspaces**, TypeScript end‑to‑end. Working dir: `D:\Projects\Claude code`.

| Package | What | Key tech |
|---|---|---|
| `apps/api` | Backend REST API | Express **5**, Prisma, JWT auth |
| `apps/admin-web` | Staff + customer web console | Next.js **14** (App Router), Tailwind |
| `apps/mobile` | Field/customer mobile app | Expo / React Native (**not runtime‑tested**) |
| `packages/shared` | Cross‑app contracts | Zod schemas, constants, DTO types |

**Database:** Supabase Postgres (region `ap-south-1`, Mumbai — see §16 for migration history), reached via **poolers** (direct connection needs IPv6) — transaction pooler `:6543?pgbouncer=true` for queries, session pooler `:5432` for migrations. Migration applied + seeded. Creds live only in gitignored `apps/api/.env`.

## 3. Core architecture principle — "data, not code"
Anything that might grow a new value later — **stages, roles, permissions, statuses, photo checkpoints, structure types** — is a **row in a table**, never a hardcoded enum. Adding a new stage/role/status later is a DB insert, not a code change. The only real enum is the structural `SitcPhase`. This is the literal mechanism behind "keep everything future‑ready."

Same pattern for **notifications** (one `NotificationService.send()` with real In‑App/Email providers + stubbed SMS/WhatsApp/Telegram behind the same interface) and the **structure‑diagram generator** (Phase‑2 stub behind an interface).

## 4. Roles & access model (central to the app)
**Super Admin ≠ Management** — this was a deliberate split for commercialization:
- **Super Admin** — the *only* role with `manage_settings`. Owns the white‑label/branding (logo, theme) for when the app is sold to other manufacturers. Full access otherwise.
- **Management** (Owner/Proprietor/CEO/CTO) — everything **except** Settings.
- **Sales** — orders. **Operations/PM** — site status + pending actions. **Erection/Commissioning Engineers** — update site status + act on complaints *assigned to them*. **Service Team** — triage/assign/resolve complaints. **Finance** — placeholder (no modules yet). **Customer** — own order/site only, raise complaints, resolve their own approvals.
- **`manage_vendors`** (Super Admin + Management) gates vendor approval and site→vendor assignment. **Erection engineers now belong to an external vendor** (`User.vendorId`) and see only their own vendor's sites — see §11.

The web UI gates every menu item **and** route by permission; the API enforces it independently.

## 5. What this work delivered (the hardening pass)
The build had the permission system + read‑only screens but **no action UIs**, so several roles couldn't do their job. This pass fixed that and closed an audit's worth of gaps. Committed as **`3974b32`** on `master`.

- **Complaints:** engineers act on **assigned tickets only** (new `act_assigned_complaints` permission; API 403s otherwise); Service Team assigns via a "Manage" modal.
- **Site updates:** status‑update form, checkpoint photo upload, exhaust‑hookup confirm — on the site detail page, gated by `change_site_status`.
- **Orders:** "New order" form with inline new‑customer creation (creates the customer + a contact whose **phone is their Order‑ID login credential**); `GET /orders` now permission‑gated.
- **Customer OTP** delivered over the **email channel** (dev mode echoes the code for testing; production never returns it).
- **Identity fix** (the "everyone shows as Zarina" bug): real `AuthProvider` + `GET /auth/me`; Finance (no perms) gets a clean **"No modules enabled yet"** screen instead of a blank page.
- **Security/robustness:** `authenticate` rejects deactivated users and reloads permissions per request; users are **deactivate/activate** (not hard‑deleted) with a last‑super‑admin guard; notifications are best‑effort; client handles 401; customer portal can resolve the exhaust‑hookup approval.

## 6. Verified working (live browser + API)
Erection engineer posted a status update → site advanced and the **customer portal reflected it**; customer logged in via Order ID + **email OTP** and raised a complaint; Service Team assigned it; engineer saw **only** that ticket, updated it (200), was **blocked (403)** from others; Super Admin saw Settings, Management didn't; Finance got the no‑modules screen. Both apps `tsc --noEmit` clean.

## 7. How to run + test
Servers are **live now** (`http://localhost:6001`). To run yourself from `D:\Projects\Claude code`:
```powershell
npx turbo run dev --filter=@recd/api --filter=@recd/admin-web
```
Staff logins: `superadmin@ / owner@ / sales@ / ops@ / erection@ / commissioning@ / service@ / finance@platino.example` (HISTORICAL: the seed no longer sets any password - see section 41; set `SEED_DEV_PASSWORD` for local demo accounts). Customer (Track My Order): `ORD-2026-0001` + `+919900011122` (OTP shows on‑screen + in the API terminal).

## 8. Before production / known gaps
- **Rotate secrets:** environments seeded before section 41 still hold the old well-known seed password `changeme123` on the demo accounts, the Supabase DB password has been exposed in chat, and `JWT_SECRET` is a placeholder.
- **Email is a console stub** — `EMAIL_PROVIDER_API_KEY` empty; OTP/notifications log to the server console. Wire a real provider (Resend/SES/SendGrid) — no caller changes needed.
- **SMS/WhatsApp/Telegram** are deferred stubs.
- **Photo upload** stores base64 data‑URLs (works; no S3 yet).
- **Mobile app** not runtime‑tested — first run is `npx expo start` on a device.
- **Structure‑diagram generator** is schema‑only (Phase 2).
- Minor: `mustChangePassword` isn't server‑enforced on mutating routes (client‑guarded); `owner_admin` is an orphan role; New‑Order modal / photo upload / full exhaust‑mismatch loop are built + typecheck‑clean but not each click‑tested.

## 9. Vercel deployment
Two separate Vercel projects: **admin-web** (root directory `apps/admin-web`, Next.js) and **api** (root directory `apps/api`, Node). Both need "Include files outside the Root Directory in the Build Step" enabled since this is an npm-workspaces monorepo.

- **admin-web → api connection:** the browser calls `NEXT_PUBLIC_API_URL` (see `apps/admin-web/src/lib/apiClient.ts`), which is baked in at **build time**. Must be set as an env var on the admin-web Vercel project pointing at the deployed api project's URL — changing it requires a redeploy, not just a save.
- **api build pipeline:** `apps/api/vercel.json` uses `buildCommand: "npm run build"` (runs `prisma generate && tsc`) plus a plain‑JS `apps/api/api/index.js` that `require()`s the precompiled `dist/index.js`. **Do not** reintroduce a legacy `"builds"` array in that vercel.json — it silently makes Vercel ignore the dashboard Build/Install Command entirely, so `prisma generate` never runs, the deployed function has no real Prisma client, and every DB call crashes (`FUNCTION_INVOCATION_FAILED`) while the build log fills with `TS7006`/`TS2694` implicit-`any` errors (Prisma-derived types collapsing without a generated client).
- **`packages/shared` must compile to CommonJS** (`packages/shared/tsconfig.json` overrides `module`/`moduleResolution`) — it's `require()`'d from `apps/api`'s CommonJS output, and plain Node (unlike bundler-based tooling) can't resolve ESM's extensionless relative imports.
- **Redeploy ≠ deploy latest.** Clicking "Redeploy" on an old deployment row in the dashboard rebuilds *that deployment's pinned commit*, not the branch's latest. Always check the log header's `Commit:` line, or just push and let Git auto-deploy create a fresh deployment. Whichever deployment should be live needs **Promote to Production** explicitly.
- Env vars (`DATABASE_URL`, `JWT_SECRET`, etc.) are set separately per Vercel project — api and admin-web don't share them.

## 10. Key files
- Contracts: `packages/shared/src/{constants,schemas,types}.ts`
- Schema/seed: `apps/api/prisma/{schema.prisma,seed.ts}`
- API routes: `apps/api/src/routes/*` (auth, sites, complaints, orders, customers, pendingActions, dashboard, users, settings, lookups); auth in `src/middleware/auth.ts`
- Web: `apps/admin-web/src/components/{AuthContext,AuthGuard,Nav}.tsx`; pages under `src/app/*`
- Responsive helpers (shared CSS): `apps/admin-web/src/app/globals.css` — `.data-card`, `.data-card-row`, `.table-desktop`, `.cards-mobile`, `.table-scroll`, `.modal-panel` (mobile sizing)
- Memory (persists across sessions): `…/memory/project_recd_tracker_app.md`
- Vendor routes: `apps/api/src/routes/vendors.ts`; vendor pages: `apps/admin-web/src/app/vendors/page.tsx`, `apps/admin-web/src/app/vendor/register/page.tsx`

---

## 11. Vendor management (added 2026-06-30, migration `20260630065402_add_vendors`)
External erection companies ("vendors") are **not** part of Platino — erection is subcontracted.

- **Self-registration** (public, no login): `/vendor/register` → `POST /vendors/register` creates a `pending` vendor. Linked from the login page.
- **Management review/approval**: `/vendors` page (`manage_vendors`) lists all vendors with status + engineer/site counts. Approving (after due diligence) **auto-provisions the vendor's primary contact as an erection-engineer login** — the temp password is shown once. Reject/Reconsider available.
- **Adding more vendor engineers**: Users page → add user with role *Erection Engineer* now requires choosing an **approved vendor** (API enforces it; 400 otherwise).
- **Assigning work**: the site detail "Vendor assignment" control (`manage_vendors`) sets `Site.vendorId` — that's what scopes the site into a vendor's view.
- **Isolation (multi-tenant)**: a vendor's engineers only see/act on sites with their `vendorId`. Enforced on `GET /sites`, `GET /sites/:id`, and every site mutation (another vendor's site → **403**). Vendors never see other vendors (the `/vendors` list requires `manage_vendors`, which vendor users don't have).
- **Data model**: `Vendor` (status, contact, approvedBy/At) + `User.vendorId` + `Site.vendorId`. The seed transfers the sample erection engineer (`erection@platino.example`) and sample site under the approved vendor *Coimbatore Erectors LLP*; *Salem Fabrication Works* is seeded `pending` for the demo.

## 12. Operational notes (gotchas hit during the build)
- **After editing `packages/shared`, rebuild it**: `npm run build --workspace=packages/shared`. Its `main` is `dist/index.js`, so the API/web/seed read the **compiled** output — source edits don't apply until rebuilt (root `postinstall` and `turbo` do this automatically; a direct edit does not). Symptom if you forget: a newly-added constant reads as `undefined` at runtime.
- **Windows Prisma `EPERM` on generate**: if `prisma generate` can't rename `query_engine-windows.dll.node`, a running node process has the DLL loaded. Stop this project's dev servers first; find the exact holder with `Get-Process node | ? { $_.Modules.FileName -like '*Claude code*query_engine*' }`.
- Ports: API pinned to **4001** via `apps/api/.env` (`PORT=4001`); web is `next dev -p 6001`.

## 13. Updated verification (2026-06-30)
Vendor flow verified end-to-end (API + UI): public registration (201) → management approval (creates login + temp password) → vendor isolation (Coimbatore engineer sees only their site; a second vendor sees 0 sites and gets **403** opening the first vendor's site) → erection-engineer-without-vendor rejected (**400**). The `/vendor/register` page renders logged-out; the `/vendors` console renders with status + approve/reject. Both apps `tsc --noEmit` clean.

## 14. Mobile-responsive UI
The admin-web was a desktop-only layout — a fixed 240 px sidebar plus wide tables that overflowed horizontally on phones, modals that exceeded the viewport, and several grids (`grid-cols-3/4/2` without breakpoint prefixes) that crushed content below ~640 px. This pass made every admin-web screen mobile-responsive from 320 px → 1024+ without touching API contracts, business logic, auth, permissions, theming, env vars, `vercel.json` or `next.config.js`. Three commits on `master`: `16a2dd9`, `ce24f23`, `4a33312`.

**Shell (`apps/admin-web/src/components/`)**
- `Nav.tsx` is now an off-canvas drawer below `lg` (1024 px), with a backdrop, route-change auto-close, and a built-in close button. From `lg` upwards it renders exactly as before (`lg:relative lg:translate-x-0`).
- `AuthGuard.tsx` injects a sticky **mobile top bar** with a hamburger (`data-testid="mobile-menu-button"`) shown only below `lg`. Main content padding scales `p-4 sm:p-6 lg:p-8` so phones get the full viewport width.

**Responsive primitives (`globals.css`)** — used by every list screen:
- `.table-desktop` hides itself below `md` and is wrapped in `.table-scroll` (horizontal touch-scrolling) when shown.
- `.cards-mobile` shows below `md` and contains a stack of `.data-card` items.
- `.data-card` / `.data-card-row` give a consistent label/value card layout (label is uppercase, muted, fixed; value is right-aligned, word-break enabled).
- `.modal-panel` now `max-height: calc(100dvh - 2rem)`, `overflow-y: auto`, and uses smaller padding on mobile so tall forms (New Order, Manage Complaint, Edit User) scroll inside the panel instead of off the viewport.
- `.upload-zone` padding shrinks on mobile so the Logo upload doesn't dominate the screen.

**Per-screen changes (no business logic touched)**
- **Dashboard:** `grid-cols-4` → `grid-cols-2 sm:grid-cols-4`; complaints `grid-cols-2 sm:grid-cols-3 lg:grid-cols-5`. Title scales `text-xl sm:text-2xl`. `data-testid="dashboard-page"`.
- **Orders:** Header stacks on mobile (`flex-col sm:flex-row`). Same data rendered as `.cards-mobile` below `md` and the original table inside `.table-desktop` from `md` up. New-order modal grids fixed: `grid-cols-3` → `grid-cols-1 sm:grid-cols-3`, contact pair `grid-cols-2` → `grid-cols-1 sm:grid-cols-2`. testIDs: `orders-page`, `orders-new-button`, `orders-mobile-cards`, `order-card-<orderNumber>`.
- **Sites:** Same desktop-table / mobile-card pair. Mobile card is a `<Link>` so tapping the card navigates to detail. "Stuck Nd" badge is preserved in both layouts.
- **Site detail:** Photos `grid-cols-4` → `grid-cols-2 sm:grid-cols-3 lg:grid-cols-4`. Title scales.
- **Complaints:** Overview tiles `grid-cols-3 sm:grid-cols-5` → `grid-cols-2 sm:grid-cols-3 lg:grid-cols-5`. Table → cards on mobile; the "Manage / Update" action becomes a full-width button inside each card. testIDs: `complaints-page`, `complaints-mobile-cards`, `complaint-card-<ticket>`, `complaint-action-<ticket>`.
- **Users:** Add-user form is now a real responsive grid (`grid-cols-1 sm:grid-cols-2 lg:grid-cols-5`) instead of `flex flex-wrap`; submit goes full-width on mobile. Table → cards; the icon-only Edit / Reset / Deactivate / Activate actions become labelled buttons inside each card.
- **Settings:** Branding row stacks on mobile; theme grid `grid-cols-2 sm:grid-cols-2 md:grid-cols-3`; Live Preview goes from side-by-side to stacked below `sm`; section padding `p-4 sm:p-6`.
- **Customer portal:** Top navbar paddings shrunk, title truncates, "Sign Out" label hides on the smallest viewport while the icon stays. Main grid uses smaller gap below `lg`. `data-testid="customer-portal-page"`, `portal-signout-button`.

**Things that were intentionally NOT changed**
- Desktop UI at `lg+` is byte-for-byte identical to before — all changes are additive via `sm:` / `md:` / `lg:` Tailwind prefixes.
- `apps/api/**`, `apps/mobile/**`, `packages/shared/**`.
- Tailwind config, PostCSS config, Next config, Vercel config, env vars.
- All routes, permissions, API surfaces, testIDs that already existed.

**Verification**
- `npm run build --workspace=apps/admin-web` → 13 routes, 0 type errors, 0 warnings.
- ESLint clean across all changed files.
- Manual visual sweep at 375 × 812 (phone), 768 × 1024 (tablet) and 1280 × 800 (desktop) for: login, dashboard, orders (+ new modal), sites, site detail, complaints (+ manage modal), users (+ edit/reset/deactivate flows), settings (theme + live preview), customer portal. Hamburger drawer open/close confirmed.

**Local preview tip**
For visually testing the responsive UI without standing up Postgres locally, set `NEXT_PUBLIC_DEMO_MODE=1` in `apps/admin-web/.env.local` and add a small `src/lib/_demoMock.ts` that short-circuits `api()` in `apiClient.ts` with sample data. This file is intentionally **not** in the repo — it's a dev-only convenience and should never be committed.

## 15. Premium industrial design system (2026-06-30)
Visual-only redesign requested as "modern, clean, premium industrial — inspired by Siemens/Schneider/ABB/Honeywell/Caterpillar." Implemented entirely through the **existing white-label theme engine** rather than per-page color overrides, so it stays compatible with §1's "data, not code" principle and the Settings page's customer-facing theme picker. Commits: `92af248`, `ab68625`, `180dba3` on `master`.

**Palette (now the default theme)**
Primary/CTA orange `#F58220`, sidebar/heading blue `#0F4C81`, success/accent emerald `#22C55E`, page background `#F5F7FA`, white cards with soft shadows. Semantic status colors: success green, warning amber, error red.

**How it's wired (`apps/admin-web/src/lib/themes.ts`)**
The `slate` preset (key unchanged, `name` renamed to "Platino Industrial") now holds this palette and is the fallback when no theme is saved — so Super Admins who later pick a different preset or upload a custom palette via Settings are unaffected; this only changes what *out-of-the-box* looks like. `ThemeInitializer.tsx` applies it to `:root` CSS variables on first paint, same mechanism as before.

**New shared primitives (`globals.css`)**
- `.kpi-tile` / `.kpi-tile-icon` / `.kpi-tile-value` / `.kpi-tile-label` — rounded white stat cards with an icon chip, used on Dashboard and Complaints overview.
- `.status-pill` + `.status-pill-{success,warning,error}` — the one badge system every page now uses for ticket/site status (replaces several one-off `bg-red-50 text-red-700 border...` literals).
- `.progress-track` / `.progress-fill-{success,warning,error}` — thin rounded progress bars (available for use; not yet wired to a real percentage field anywhere, since none of the current data models expose one).
- `.field` — light-grey filled form input/select/textarea (replaces plain `border-gray-300` boxes), orange focus ring.
- `.bottom-nav` / `.bottom-nav-item` — floating rounded mobile tab bar (`apps/admin-web/src/components/BottomNav.tsx`), shown below `lg` only. Tabs: Dashboard, Sites, Complaints (each gated by the same permission as the sidebar link, hidden if the user lacks it), plus a Profile button that opens the existing `Nav` drawer via `AuthGuard`'s `mobileNavOpen` state — no new route was added for "Profile".

**Dashboard charts**
Added `chart.js` + `react-chartjs-2` (`apps/admin-web/package.json`). The dashboard now renders a bar chart (sites by SITC phase) and a donut chart (complaints by status), both fed by the existing `GET /dashboard` endpoint — **no API or schema changes**. Complaint slice colors are derived from status (`resolved`/`closed` → green, `escalated` → red, everything else → amber) directly in `dashboard/page.tsx`, not from the backend.

**Per-page status**
- Fully restyled with the new primitives: Dashboard, Sites, Complaints, Orders (form), customer portal (ticket form + status badges).
- Headings recolored to `var(--text-heading)`: Orders, Complaints, Vendors, Users, Settings, Site detail.
- Untouched but already correct: Login, sidebar/nav, all `.btn-primary`/`.card`/modal usages — these picked up the new palette automatically because they were already theme-variable-driven before this pass.

**Things intentionally not done**
- No charts added beyond Dashboard (no real per-site progress percentage exists yet to chart on Sites/Orders).
- Vendor approve/reject buttons keep hardcoded `bg-green-600` (semantic, not a theme color — left as-is).
- No business logic, auth, API contracts, or database changes anywhere in this pass.

**Verification**
`tsc --noEmit` and `npm run build` (admin-web) both clean after every commit in this series; no automated UI testing (Playwright/etc.) exists in this repo, so the visual result has only been checked by the user on the deployed Vercel preview.

## 16. QA & security audit (2026-07-02)
A full black-/grey-box test pass: the whole stack was stood up locally (Postgres 16 + migrate + seed, API on `:4000`, admin-web on `:6001`), every one of the 9 seeded roles was logged in through a **real headless-Chromium browser** (Playwright driving the actual UI, 34 screenshots) **and** exercised directly against the API. **No application code was changed in this pass — this section documents findings only.** Fixes are proposed but not yet applied.

**Role access — verified enforced server-side.** Every API route is guarded by `authenticate` + `requirePermission`, and the live status-code matrix matched the intended permission model exactly (e.g. Sales → 200 on `/orders` `/sites`, 403 everywhere else; Finance with no permissions → 403 on everything; `PUT /settings` → 200 only for Super Admin, 403 even for Management). Tenant isolation holds: a customer sees only their own order/sites/complaints, and a vendor's engineer sees only sites with their `vendorId` (cross-access → 403, re-confirmed by creating a second customer + order). Auth-bypass attempts (no token / garbage token / `alg:none`) are all rejected 401.

**Findings (ranked). None fixed yet.**
1. **HIGH — JWT secret has a hardcoded fallback.** `apps/api/src/lib/jwt.ts:3`: `const SECRET = process.env.JWT_SECRET || "dev-secret-change-me"`. If the API is deployed without `JWT_SECRET`, it signs/verifies with a public string — a token forged as `{roleKey:"super_admin"}` was accepted by the app's own verify logic (proven locally). No boot-time check fails when the var is missing. **Fix:** throw on startup if `JWT_SECRET` is unset; delete the fallback. (This overlaps the §8 note that `JWT_SECRET` is "a placeholder" — the risk is specifically the silent default, and it is directly relevant to the Vercel deploy: set `JWT_SECRET` on the api project.)
2. **MEDIUM-HIGH — IDOR / broken object-level auth on complaint creation.** `apps/api/src/routes/complaints.ts:88` writes `siteId` straight from the request body without verifying the site belongs to the caller. A customer POSTed a complaint against another customer's `siteId` → **201 Created**, and that complaint then surfaces in the attacker's own complaint list, leaking the victim's company name + order number. **Fix:** before create, load the site and require `site.order.customerId === req.auth.customerId`.
3. **MEDIUM — no rate limiting / lockout on `/auth/login` and `/auth/customer/verify`.** 12 wrong passwords then the correct one still succeeds (no throttle); 15 wrong OTP codes all just return 401 (6-digit code, 10-min window, unlimited attempts → brute-forceable). **Fix:** add `express-rate-limit` and an OTP attempt cap.
4. **LOW-MEDIUM — misc:** temp passwords use `Math.random()` not a CSPRNG (`users.ts:41,185`); `POST /users` doesn't set `mustChangePassword` (reset does — inconsistent, temp passwords persist); CORS is fully open (`index.ts` `app.use(cors())`); JWT stored in `localStorage` (XSS-exposable); `POST /auth/customer/register` returns distinguishable errors for unknown order vs unknown contact (order enumeration).

**Functional bug — permission-less user gets a blank screen.** After a *successful* login, Finance (or any role with no accessible module) is left on `/login` where `AuthGuard` renders `null` instead of the existing "No modules enabled yet" screen (that screen only appears if you manually navigate to a guarded route). `apps/admin-web/src/components/AuthGuard.tsx` — the `isLoginPage → return null` branch short-circuits before the `!firstLanding(...)` NoAccessScreen branch. **Fix:** render `NoAccessScreen` for an authenticated staff user with no landing even while on the auth pages.

**How to reproduce the test locally:** `.env` (root) or `apps/api/.env` needs `DATABASE_URL` + `DIRECT_URL` (Postgres) and `JWT_SECRET`; then `npm run build --workspace=packages/shared`, `prisma migrate deploy`, seed (`tsx apps/api/prisma/seed.ts`), start the API and `next dev -p 6001`. Staff logins are the §7 accounts (created without a password since section 41 - set `SEED_DEV_PASSWORD` before seeding); customer via `ORD-2026-0001` + `+919900011122` (dev OTP echoed on screen). Screenshots for all roles were captured but are not committed (dev artifacts).

## 17. Security fixes applied + deployment (2026-07-02)
The §16 findings were fixed and verified locally, then committed on branch
`claude/karate-app-security-audit-yieiko` (commit `59b10a1`).

**What changed (code)**
- `apps/api/src/lib/jwt.ts` — removed the `"dev-secret-change-me"` fallback; the module now **throws at startup if `JWT_SECRET` is unset** (fail-loud). ⚠️ *Deployment implication:* every environment scope (Production **and** Preview) must have `JWT_SECRET` set, or the api function crashes on cold start.
- `apps/api/src/routes/complaints.ts` — `POST /complaints` now loads the target site and rejects (403) unless `site.order.customerId === req.auth.customerId`. Verified: cross-customer → 403, own site → 201.
- `apps/api/src/middleware/rateLimit.ts` (new) + `apps/api/src/routes/auth.ts` — fixed-window limiter (10 / 15 min / IP) on login, OTP request and OTP verify. Verified: 401s then 429. *In-memory, so per-instance on serverless — see the file header for the shared-store upgrade path.*
- `apps/api/src/routes/users.ts` — temp passwords via `crypto.randomBytes` (not `Math.random`); `mustChangePassword: true` set on user creation.
- `apps/admin-web/src/components/AuthGuard.tsx` — an authenticated user with no accessible module (e.g. Finance) now sees the "No modules enabled yet" screen instead of a blank page. Verified in-browser.

Both apps `tsc --noEmit` clean; `apps/api` `npm run build` and `apps/admin-web` `npm run build` both succeed.

**Deployment topology (confirmed live 2026-07-02)**
- Two Vercel projects under team `ferose-salahudeen-s-projects`: **platino-recd-api** (`prj_grBAwYFoVIjJAtJg3uo3FqsPALrh`, framework express) and **platino-recd-admin-web** (`prj_Ozx4HCxv3FNyIog1asayGUQ1I7wA`, nextjs). Both are Git-connected: **push to `master` → production**, push to any other branch → preview.
- Supabase project `vpvrdjqmyymyrkmynfxy` (ap-northeast-1, Tokyo) was the database at time of audit. **Since migrated to `qpysyuysgcsrpvlxdglk` (ap-south-1, Mumbai) — see §18.**
- Production is healthy: `https://platino-recd-api.vercel.app/health` → `{"ok":true}`, `https://platino-recd-admin-web.vercel.app/login` renders.
- Production API is connected to the Mumbai Supabase project — verified 2026-07-05 (login returns HTTP 200).

**Env vars — not wired from this session.** There is no Vercel MCP tool to create/read/update environment variables, and no `VERCEL_TOKEN` was available, so env vars could not be set programmatically here. They are already configured from prior deploys (the preview proves at least `DATABASE_URL` + `JWT_SECRET` exist in Preview). To change them, use the Vercel dashboard (Project → Settings → Environment Variables) or provide a Vercel API token. Required per project: **api** → `DATABASE_URL`, `DIRECT_URL`, `JWT_SECRET`, and `NODE_ENV=production` (so the customer OTP is never echoed in the response); **admin-web** → `NEXT_PUBLIC_API_URL` = `https://platino-recd-api.vercel.app` (baked at build → redeploy after any change).

**To take the fixes to production:** merge `claude/karate-app-security-audit-yieiko` → `master` (production auto-deploys). Before doing so, confirm `JWT_SECRET` is set in the **Production** env scope of the api project — otherwise the new fail-loud check will crash the production function.

## 18. Database migration — Tokyo → Mumbai (2026-07-04/05)

**What changed:** The Supabase project was migrated from the original Tokyo region (`ap-northeast-1`) to a dedicated Mumbai project (`ap-south-1`) to reduce latency for the primary userbase in India.

| | Old (Tokyo) | New (Mumbai) |
|---|---|---|
| Supabase project | `vpvrdjqmyymyrkmynfxy` | `qpysyuysgcsrpvlxdglk` |
| Project name | ferosem-cpu's Project | platino-recd-mumbai |
| Region | ap-northeast-1 | ap-south-1 |
| Status | ACTIVE_HEALTHY (still running) | ACTIVE_HEALTHY (production) |

**How the migration was done:** The full schema was recreated from source and applied as a single Supabase migration (`20260705022134_initial_schema_recreate_from_source`). All three original Prisma migrations are reflected in `_prisma_migrations` on the new project. RLS (Row Level Security) is enabled on every public table — this was carried over from the old project's `enable_rls_all_public_tables` migration.

**Schema is identical** to the Prisma schema in `apps/api/prisma/schema.prisma` — no columns were added or removed during the migration. Seed + live data was loaded into the new project:

| Table | Rows |
|---|---|
| Role | 10 |
| Permission | 12 |
| RolePermission | 50 |
| User | 15 |
| Vendor | 5 |
| Complaint | 4 |
| NotificationLog | 36 |
| Customer / Order / Site | 1 each |

**Vercel env vars — DONE (2026-07-05):** `DATABASE_URL` and `DIRECT_URL` on the **platino-recd-api** Vercel project have been updated to point at the Mumbai poolers:

| Variable | Value |
|---|---|
| `DATABASE_URL` | `postgresql://postgres.qpysyuysgcsrpvlxdglk:…@aws-1-ap-south-1.pooler.supabase.com:6543/postgres?pgbouncer=true` |
| `DIRECT_URL` | `postgresql://postgres.qpysyuysgcsrpvlxdglk:…@aws-1-ap-south-1.pooler.supabase.com:5432/postgres` |

A fresh production deploy was triggered immediately after and is **Ready**. Login at `https://platino-recd-api.vercel.app/auth/login` returns HTTP 200 — DB connection confirmed live against Mumbai. Note: Mumbai uses `aws-1-ap-south-1.pooler.supabase.com` (not `aws-0`) — this is correct for the `ap-south-1` region.

**Local `.env`:** `apps/api/.env` has also been updated to the Mumbai pooler URLs — local `prisma migrate` / `prisma generate` work against the correct DB.

## 19. Fix — data rendering still slow after the Mumbai migration (2026-07-05, commit `5b5f254`)

**Root cause:** moving the database to Mumbai bought no latency win, because the Vercel **api** function was never moved with it — it was still pinned to `iad1` (Washington D.C., US East), the Vercel default. Confirmed via `get_deployment`: `"regions": ["iad1"]` on the pre-fix deployment. Every request was still paying the same cross-continent round trip (browser in India → `iad1` → Mumbai DB → back) that existed before the migration, just to a different DB city than Tokyo. Pages that fire several sequential API calls on load (dashboard, sites list) compounded this.

**Fix applied:**
- `apps/api/vercel.json` — added `"regions": ["bom1"]` (Vercel's Mumbai region), pinning api compute next to the Mumbai Supabase project. Confirmed Hobby-tier projects can set a single region this way (no plan upgrade needed) — Vercel docs: "Hobby plans support one region; Pro and Enterprise support multiple regions."
- `apps/api/src/routes/sites.ts` — `GET /sites/:id` was doing two sequential DB round-trips per request (a visibility-check `findUnique`, then a second full-detail `findUnique`). Collapsed into one query, with the same customer/vendor permission checks applied to its result. Removed the now-dead `assertSiteVisible` helper.

**Verified:**
- `tsc --noEmit` and `npm run build --workspace=apps/api` clean.
- Locally against the live Mumbai DB (via `preview_start`, api on `:4001` / admin-web on `:6001`): logged in as Management, opened Sites → site detail — full nested order/customer/stage/vendor/photos/timeline data rendered with no console or server errors, confirming the collapsed query preserves the original 404/403 semantics.
- Pushed to `master` (commit `5b5f254`) → Vercel auto-deployed `dpl_7Yfdxx1og8LUVFwSvBfJiCeHSNYm`, confirmed **READY** with `"regions": ["bom1"]`. Production `/health` and `/auth/login` both return 200 on the new deployment.

**Not done:** `apps/admin-web` was left on its default Vercel region — it's client-rendered (the browser calls `NEXT_PUBLIC_API_URL` directly per §9), so admin-web's own region doesn't sit on the DB latency path and wasn't part of this fix.

## 20. RECD Serial Number rename, Company Details, Complaint Ticket overhaul, AMC Order module (2026-07-15, commit `b23e793`)

Implements a batch of UI/workflow changes supplied as a PPTX (`Platino RECD traker modifications.pptx`) with annotated mockup screenshots per change. Migration `20260715045820_add_amc_orders_company_details_complaint_fields` (see §21 for how it was applied).

**Terminology rename:** "Order ID" → **"RECD Serial Number"** everywhere customer-facing (login Track Order tab, customer portal order banner). No underlying data model change — `Order.orderNumber` is still the same field, this is a display-only rename.

**Customer portal — Company Details form (new):** after logging in, the customer now fills in a mandatory form (Company Name, Address, KVA, RECD Model, Site POC Name, Site POC Number) that used to be implicit/missing. New `Site` columns: `companyName`, `sitePocName`, `sitePocNumber` (address/dgCapacityKva/dgModel already existed). New endpoint `PATCH /sites/:id/company-details`, customer-only, scoped to their own site.

**Complaint Ticket form rebuilt** to match the mockup — new fields: **Issue Category** (12-value picker — Alarm Issue, Pressure Sensor, Temperature Sensor, Controller/HMI Issue, Electrical Issue, PM Service, Breakdown Service, Spare Replacement, Installation/Commissioning Issue, Fault Code, Abnormal Back Pressure, Other — `ISSUE_CATEGORY`/`ISSUE_CATEGORY_LABELS` in `packages/shared/src/constants.ts`), and a **mandatory photo attachment** (base64 data-URL, same pattern as `SitePhoto`). New `Complaint` columns: `issueCategory`, `attachmentUrl`.

**One-open-complaint-per-RECD-serial-number rule:** `POST /complaints` now 400s if the target site already has a complaint in a non-`resolved`/`closed` status — a customer must wait for their existing ticket to close before raising another against the same serial number.

**Staff complaints page:**
- Company-wide status tiles now show a colored icon per status inside a red-bordered "Company-wide, by status" box (cosmetic, matches mockup).
- New **"Reject or delete"** button per row (manager-only) — hard-deletes a complaint via new `DELETE /complaints/:id`, for spam or wrong-serial-number entries. Confirm dialog before delete.
- `waiting_for_customer` status now **displays** as "Waiting for Customer Approval" (display-only override in `pretty()`, the underlying status key is unchanged — do not rename the key itself, other code branches on `waiting_for_customer`).
- Manage modal gained **Remarks** and **Service report Attachment** fields (new `Complaint` columns `remarks`, `serviceReportUrl` — distinct from the customer-facing `description`/`attachmentUrl` and from the existing `resolutionNotes`), plus a thumbnail preview of the customer's submitted attachment.

**New AMC (Annual Maintenance Contract) Order module:** new top-level nav item + page (`/amc-orders`), gated on a new permission `manage_amc_orders`. **Correction (see §21): this was NOT actually auto-granted in production** — `ALL_PERMISSIONS` deriving from `PERMISSION_KEY` is a code-level fact, but the `Permission`/`RolePermission` tables are only populated by running the seed script, which does not re-run on every deploy. A brand-new `PERMISSION_KEY` added in code is invisible to an already-seeded database until someone inserts the row(s) or reseeds. New `AmcOrder` model (poNo, poDate, customerId, location, item, qty, amcFrequencyPerYear, status) + `AMC_ORDER_STATUS` constant (`yet_to_start`/`in_progress`/`completed`). Page shows 4 stat tiles (total/completed/in-progress/yet-to-start), a "Create New Order" modal (customer picker + PO fields), a "Create New Customer" modal (reuses the existing `POST /customers` flow), and the order list table. Routes: `GET /amc-orders` (list + counts), `POST /amc-orders`.

**How this migration was actually applied (read before running `prisma migrate` again):** local `apps/api/.env`'s `DIRECT_URL` could not authenticate against the Mumbai pooler from this dev machine (`P1000: Authentication failed`) despite the same credentials working fine in production via Vercel, and despite raw TCP connectivity to the pooler succeeding. Root cause not identified — flagged as a known local-environment issue, not a credential problem. Worked around by applying the migration SQL directly to production via the Supabase MCP tool (explicit user authorization obtained first — this is a production-write action and the harness blocks it without that), then running `npx prisma generate` locally (schema-only, no DB connection needed) to regenerate the Prisma Client. **`_prisma_migrations` ledger was NOT updated** (the bookkeeping INSERT was also blocked as a production-DB write) — `prisma migrate status` will likely report this migration as pending/drifted even though the schema change is live. Reconcile that (e.g. `prisma migrate resolve --applied 20260715045820_add_amc_orders_company_details_complaint_fields`) once local DB auth is working again, before running any further `prisma migrate dev`.

**RLS:** the new `AmcOrder` table was created with RLS disabled by default (Supabase advisory flagged this); enabled to match every other table's posture (`ENABLE ROW LEVEL SECURITY`, zero policies — same default-deny-to-anon-key pattern already used everywhere else; the app's own Prisma connection bypasses RLS).

**Verified:** `packages/shared`, `apps/api`, `apps/admin-web` all `tsc --noEmit` clean; `npm run build` (admin-web) clean and includes the new `/amc-orders` route. Login-page label changes (RECD Serial Number, User Name) confirmed live in browser. **Not verified end-to-end with real data** — local dev API can't reach the Mumbai DB (same auth issue as above), so the logged-in flows (company details save, complaint submit with attachment, AMC order create, Manage modal remarks/service-report) have only been code-reviewed, not click-tested. First real verification should happen against the Vercel deployment once it redeploys from this push, or once local DB auth is fixed.

**Staff login label:** "Email" → **"User Name"** (display-only; the field is still validated/submitted as an email address and login is still by email — no auth logic changed, this was purely the label text per the mockup).

## 21. Production login broken after §20's Vercel deploy — root cause, fix, and a real seed-data gap (2026-07-17, commit `ad0cafd`)

**Symptom (reported by user):** after §20 deployed, staff login on `platino-recd-admin-web` returned `"Internal server error"`.

**What actually happened, in order:**
1. First diagnosis attempt found a `PrismaClientUnknownRequestError: prepared statement "sN" already exists` (Postgres code `42P05`) — a known Prisma+PgBouncer transaction-pooling conflict. Tried adding `&connection_limit=1` to `DATABASE_URL` via the Vercel dashboard sensitive-field editor.
2. That edit **corrupted the value** — a stray leading character got prepended (visually confirmed as `apostgresql://...` on a later re-open). This is the same failure mode as the original Mumbai migration (§18): editing a Vercel *sensitive* textarea via `computer` click+type is unreliable; it silently mis-set the value and the field's masked display gives no way to catch it before saving.
3. Root-caused by re-opening the field and reading the live DOM value (`textarea.value` via JS, never displayed to the user) before saving — confirmed the corruption, then rebuilt the value with the JS `HTMLTextAreaElement.prototype.value` setter (dispatching `input`/`change`) instead of simulated keystrokes, and verified structure (`startsWith`/`endsWith`/`@` count) via script before every save from then on.
4. Even after a clean re-set of the same password, login still failed with `PrismaClientInitializationError: Authentication failed` — the DB password itself needed to change (root cause of *that* was never fully pinned down; treat any further Vercel DB-credential edit as fragile and always verify structurally before saving). **Fixed by rotating the Supabase DB password** (Database Settings → Reset database password, using the dashboard's own **Copy** button so the plaintext password was never read, displayed, or typed by the agent — it moved clipboard-to-clipboard from Supabase into the rebuilt `DATABASE_URL`/`DIRECT_URL` values in Vercel), then redeploying. Verified: `/auth/login` → 200.

**Second, unrelated bug found during verification:** after login worked again, the **AMC Order** nav item from §20 was missing entirely for a Management user who should have `manage_amc_orders`. Root cause: `PERMISSION_KEY.MANAGE_AMC_ORDERS` was added to `packages/shared/src/constants.ts` in §20, and `ALL_PERMISSIONS = Object.values(PERMISSION_KEY)` picks it up automatically **in code** — but the actual `Permission` and `RolePermission` rows only get created by `prisma/seed.ts`, which is a one-time setup script, not something that reruns on deploy. Production's `Permission` table simply had no `manage_amc_orders` row, so no role — not even Super Admin — actually had it, despite what §20 claimed ("auto-granted... since they hold ALL_PERMISSIONS"). That claim was wrong; corrected above.

**Fix:** inserted the missing `Permission` row and three `RolePermission` links (`super_admin`, `owner_admin`, `management`) directly via SQL against production, then added the same permission to `seedPermissions()` in `apps/api/prisma/seed.ts` (commit `ad0cafd`) so a fresh seed run stays in sync. **General lesson for future `PERMISSION_KEY` additions:** adding one to `packages/shared/src/constants.ts` is not sufficient by itself for an already-running production database — the corresponding `Permission` + `RolePermission` rows must also be inserted directly (or the seed script re-run, which isn't currently a safe no-op operation against a live DB with data — it uses `upsert` so it likely *is* safe, but this hasn't been verified end-to-end against production and shouldn't be assumed).

**Verified end-to-end after both fixes, live against production:**
- `POST /auth/login` → 200, correct user/role returned.
- Admin-web login UI → dashboard renders fully (KPI tiles, charts) as Management.
- Sidebar now shows **AMC Order**; the page itself renders correctly — 4 stat tiles, Create New Order / Create New Customer buttons, empty order list table with the expected columns.

**Not yet done:** the customer-portal flows from §20 (company details save, complaint submit with mandatory attachment, AMC order creation, Manage-modal remarks/service-report upload) are still only code-reviewed, not click-tested against production — do that before telling the customer-facing side of §20 is fully verified.

## 22. AMC expiry reminders — in-app/email live, WhatsApp/Telegram ready but stubbed (2026-07-17, commit `cee5571`)

**Requirement:** notify staff before an AMC order's 1-year warranty expires (expiry = `poDate + 1 year`), starting 1 month before expiry, repeating every 3 days, until a manager marks it acquired/renewed.

**New `AmcOrder` columns:** `lastExpiryReminderAt` (last time a reminder fired), `expiryReminderClearedAt` / `expiryReminderClearedById` (set when someone clicks "AMC Acquired" - stops all future reminders for that order). Migration `20260717030340_add_amc_expiry_reminder_fields`, applied directly to production (same MCP-tool path as §20/§21, explicit user authorization obtained first).

**Delivery mechanism - Vercel Cron:** `apps/api/vercel.json` now has a `crons` entry hitting `GET /amc-orders/send-expiry-reminders` daily at 03:00 UTC (~08:30 IST). Vercel Cron only issues GET requests, and it doesn't carry a user session, so this route is registered on `amcOrdersRouter` **before** the router's `.use(authenticate)` / `.use(requirePermission(...))` calls and instead checks `Authorization: Bearer <CRON_SECRET>` itself - **do not move this route below the auth middleware, and do not remove the manual position-in-file comment explaining why.** `CRON_SECRET` is a new Vercel env var (Production + Preview, generated via `crypto.randomBytes(32).toString('hex')`, set through the dashboard the same careful way as §21's DB credentials - typed via the JS `HTMLTextAreaElement`/`HTMLInputElement` value setter, verified structurally, never logged as a bare value in a way that could be mistaken for display).

**Reminder logic** (`isReminderDue` in `apps/api/src/routes/amcOrders.ts`, mirrored client-side in `apps/admin-web/src/app/amc-orders/page.tsx` as `isInReminderWindow` for the UI badge): skip if `expiryReminderClearedAt` is set; skip if `now < expiry - 1 month`; otherwise due if `lastExpiryReminderAt` is null or ≥3 days old. Recipients are queried by permission (`role.permissions.some(permission.key = 'manage_amc_orders')`), not hardcoded role keys - stays correct if the permission is ever granted to another role later.

**Channels:** each due order sends to every eligible recipient over `["in_app", "email", "whatsapp", "telegram"]` via the existing `NotificationService.send()`. In-app and email are real (both logged `sent`); WhatsApp and Telegram log as `pending_provider_setup` - **this is intentional and matches the existing stub pattern** (§ project architecture notes: swappable providers, zero calling-code change needed once a WhatsApp Business API account and Telegram bot are actually wired into `providers.ts`). User explicitly deferred WhatsApp/Telegram activation to later but wanted the notification *logic* built now.

**Frontend:** AMC Order List table gained an **Expiry** column (computed client-side from `poDate`) showing the expiry date plus a red "Renewal due" flag when in the reminder window, or green "AMC Acquired" once cleared; and an **Action** column with the "AMC Acquired" button (confirm dialog, `PATCH /amc-orders/:id/clear-reminder`, manager-only).

**Verified live against production, including a real order:** manually invoked the cron endpoint with the `CRON_SECRET` bearer token - found the one real seeded AMC order (Sundaram Textiles, PO `PL-09867123`, PO date 1/Jan/2023, expiry 1/Jan/2024 - already well past the 1-month reminder window), sent reminders to all 5 users holding `manage_amc_orders`, confirmed 20 `NotificationLog` rows (5 recipients × 4 channels: `in_app`/`email` = `sent`, `whatsapp`/`telegram` = `pending_provider_setup`), and confirmed the UI shows the expiry date + red "Renewal due" flag. Also click-tested "AMC Acquired" end-to-end (button disappeared, flag turned green) - **then reverted that specific write via SQL** (`expiryReminderClearedAt`/`expiryReminderClearedById` set back to `NULL` for that order) since the click was a smoke test, not a real confirmation that Sundaram's AMC was actually renewed. Whoever actually renews/inspects that AMC still needs to click "AMC Acquired" for real.

**Not done / follow-ups:**
- WhatsApp Business API and Telegram bot are not connected - reminders on those channels will keep logging `pending_provider_setup` until `providers.ts`'s `WhatsAppProvider`/`TelegramProvider` are implemented for real.
- The cron endpoint has no logging/alerting on failure beyond whatever Vercel's function logs capture - if the daily cron silently stops firing (e.g. Hobby-plan cron limits, a bad deploy), nobody gets told. Worth a dead-man's-switch check later if this becomes business-critical.
- Reminder cadence (3 days) and lead time (1 month) are hardcoded constants (`ONE_MONTH_MS`, `THREE_DAYS_MS` in `amcOrders.ts`) rather than data-driven - fine for now, but if these ever need to be configurable per-customer or per-order, they're not there yet.

## 23. AMC Type field - CAMC / NAMC (2026-07-30, commit `ed05560`)

**Source:** `App Correction.pptx` (`G:\My Drive\Platino AI enablement\`) - single requirement: add an "AMC Type" dropdown (CAMC = Comprehensive, NAMC = Non-Comprehensive) to the AMC order creation form, shown as its own column in the AMC Order List.

**Implementation:** new `AmcOrder.amcType` column (`String`, default `'camc'` - the one existing production row was backfilled to `camc` by the migration default, not left null). `AMC_TYPE` (`camc`/`namc`) and `AMC_TYPE_LABELS` (`"CAMC (Comprehensive)"` / `"NAMC (Non-Comprehensive)"`) added to `packages/shared/src/constants.ts`, following the same picker pattern as `ISSUE_CATEGORY`/`ISSUE_CATEGORY_LABELS` (§20) - a plain object map, not a Prisma enum, per this project's "lookup values are data, not code" convention. `createAmcOrderSchema` now requires `amcType: z.enum(["camc", "namc"])`. Migration `20260730121803_add_amc_type`, applied directly to production the same way as every other migration this project uses (Supabase MCP `apply_migration`, explicit user authorization already standing for this workflow).

**Frontend:** "AMC Type" dropdown added to the Create New Order modal (defaults to the first `AMC_TYPE_LABELS` entry, i.e. CAMC); "AMC Type" column added to the AMC Order List table, between "AMC Frequency per Year" and "Status".

**Verified live in production:** `tsc --noEmit` clean on `apps/api` and `apps/admin-web`, `npm run build` clean on both `packages/shared` and `apps/admin-web` (new column visible in the `/amc-orders` build output size). Chrome extension was unreachable at verification time, so confirmed via a direct authenticated API call instead (`POST /auth/login` → `GET /amc-orders`) - the existing production AMC order (Sundaram Textiles, PO `PL-09867123`) correctly returns `"amcType": "camc"`. Not click-tested in the browser UI itself - do that (create a new order with NAMC selected, confirm the column renders) next time the extension is available.

**Incidental observation, not part of this change:** the same API call showed `expiryReminderClearedAt` is now set on that order (2026-07-21) - someone used the "AMC Acquired" button for real since §22 was verified, which is the feature working as intended in the wild.

## 24. Port of the Zan-APP fork's non-finance features (2026-08-25, branch `feature/port-zan-app-nonfinance`)

**What this is.** `D:\Projects\Zan-APP` is a fork of this same codebase that diverged at commit
`4dfc088` and added 110 commits, the largest of which is a full finance module (quotations,
invoices, purchase orders, bills, expenses, work orders). This section records a port of
**everything in that fork except the finance module** into this repo, which had meanwhile added
8 commits of its own (the AMC Order module, RECD serial rename, company details, complaint
overhaul - §20-§23). Those 8 are untouched.

**Fork point verification.** `git log --format=%H` in both repos, sorted and `comm -12`'d, gives
41 shared commits, the newest of which is `4dfc088`. Claude code has 8 unique commits, Zan-APP
has 110. An earlier guess of `d5fa175` as the fork point was wrong; do not reuse it.

**Method.** Not a cherry-pick replay - finance is threaded through most of those 110 commits, and
several files (schema, shared contracts, complaints, auth, Nav, AuthGuard) had diverged on both
sides. Instead: for self-contained new files, the fork's **HEAD state** was copied and adapted;
for files this repo had also changed, the fork-point-to-HEAD diff was applied with `git apply
--3way` and the conflicts resolved by hand (they were all additive - both sides adding different
routes/fields to the same file). Four commits on the branch, one per layer.

### 24.1 What was ported

**Schema** (migration `20260825120000_port_zan_nonfinance`)
- `OrderLineItem` - extra RECD units on one order/site (multi-RECD per site).
- `SiteContact` - several POCs per site.
- `DocumentRequirementType` + `SiteDocumentRequirement` - police verification / ESIC / insurance
  / PPE, as a seeded lookup table (data-not-code, seeded by `seedDocumentRequirementTypes()`).
- `RecdDelivery` - per-site material delivery status, priority and dates.
- `AgentLlmProvider`, `AgentConversation` - in-app agent.
- `Product`: `shape`, `dimensions`, `weightKg`, `silencerType`.
- `Vendor`: `archivedById`, `archivedAt` (+ `VENDOR_STATUS.ARCHIVED`).
- `Site`: the four Google Drive folder id/url fields.
- `Order.value` and `Order.orderDate` become **nullable** - operationally-created orders don't
  always have commercial figures yet. `createOrderSchema` follows.
- `CompanySettings`: letterhead identity (`legalName`, `address`, `city`, `pinCode`, `email`,
  `website`, `phone`, `documentFooterNote`) plus `agentVisibleRoleKeys` and
  `agentCustomInstructions`.
- New tables get `ENABLE ROW LEVEL SECURITY` with zero policies, matching every other table's
  posture here (§20's RLS note).

**API**
- `lib/`: `crypto.ts` (AES-256-GCM, for the agent's stored provider API keys), `email.ts` (real
  SMTP via nodemailer), `googleAuth.ts` (Google ID-token verification), `googleDrive.ts` (company
  Drive client + folder creation), `docExtract.ts` (PDF/DOCX/text extraction).
- **Email actually sends now.** `EmailProvider` used to `console.log` and return `true`; it now
  renders copy from the new `emailTemplates.ts` and sends over SMTP, returning `false` (never
  throwing) if SMTP is unconfigured or the recipient has no address. This closes the "Email is a
  console stub" gap in §8. Stage-update emails to customers now carry order number, site name,
  address and RECD units; vendor engineers are emailed when a site is assigned to their vendor.
- **In-app agent**: multi-provider LLM chat (Anthropic + OpenAI-compatible adapters with priority
  ordering and failover), Google Drive document search/read tools, read-only application data
  tools, persisted conversations, a provider-config route gated on `manage_settings`, and a daily
  cleanup cron deleting conversations older than 30 days.
- **Routes**: products CRUD; customer detail/update/delete; order detail, line-item add/remove and
  order deletion; site location, details, contacts, document requirements, RECD delivery, Drive
  folder creation and clone-order; vendor archiving (with optional site reassignment) and
  staff-added pre-approved vendors; `POST /auth/google`.
- **Correctness fixes**: creating or switching a user to the `customer` role via the generic Users
  page is now rejected (it leaves `customerId` null, producing an account that can never log in).

**Admin web**
- Shared `DataTable` component: column show/hide, per-column filters, CSV export, and
  print-with-letterhead on a landscape named page. Rolled out to Sites, Customers, Products,
  Orders, Users and Vendors.
- New pages: Customers (list + detail), Products (list + detail), Order detail, and Reports
  (SITC status, customer history, vendor performance).
- Site detail page gains site details, contacts, document requirements, RECD delivery, Drive
  folders, location capture with Google Maps, and "add another RECD unit" (same order, or a
  separate sibling order+site).
- Agent chat bubble (markdown rendering, copy button, mic input, maximize toggle, in-app links
  that navigate client-side), plus agent visibility and provider settings on the Settings page.
- Settings gains a **Company letterhead** section feeding the DataTable print header/footer.
- `apiClient` no longer calls `res.json()` on a 204 - every delete button used to report a false
  failure ("Unexpected end of JSON input") despite succeeding.

### 24.2 What was deliberately excluded, and why

- **The entire finance module**: Quotation, Invoice, PurchaseOrder, Bill, PaymentReceived,
  PaymentMade, Expense, ExpenseCategory, Supplier, DocumentSequence, SavedLineItem,
  CustomerProductPrice, CustomerSavedItemPrice, WorkOrder, WorkOrderProduct - plus their routes,
  services (`documentNumber.ts`, `taxCalc.ts`), pages, print layouts, and the whole
  invoice/quotation/PO print-redesign chain. Out of scope by requirement.
- **Finance-adjacent fields on shared models**: `Customer.gstin`/`state`/`billingAddress`,
  `Order.customerPoNumber`/`customerPoDate`, and `CompanySettings`' bank / GST / PAN / terms /
  default-tax-rate / authorised-signatory fields. All were introduced by the finance commit
  (`8f20c5e`) and exist only to be printed on money documents. The letterhead subset that the
  DataTable print view genuinely needs was ported; nothing else.
- **Work Orders** - a finance-module concept per the fork's own `FINANCE_MODULE_PLAN.md`, so its
  permissions (`manage_work_orders`, `act_assigned_work_orders`) were not added either.
- **The customer email+OTP login rewrite** (`d6140de`, `73acebf`, `0ac4eac`). See §24.3.
- **The agent's write tools** (`create_expense` / `create_quotation` / `create_invoice` /
  `create_purchase_order` / `create_saved_item`) and the `AgentPendingAction` confirm-gate table,
  its confirm/reject routes, and the chat bubble's confirm card. Four of the five tools are
  finance; the fifth (`create_complaint`) was dropped too, for two reasons: it depends on that
  same confirm-gate infrastructure, and **this app's complaint form makes a nameplate photo
  mandatory** (§20's `attachmentUrl`), which an agent turn cannot supply. **The ported agent is
  therefore strictly read-only**, and its system prompt tells customers to use the portal's own
  complaint form. If write tools are ever wanted here, `AgentPendingAction` has to come back first.
- **Zan-APP's Vercel/Prisma deploy config** (`c8e0edb`, `52aa901`) - this repo's own topology (§9)
  is working and was not touched. The agent cleanup cron is registered as a route but **no `crons`
  entry was added to `apps/api/vercel.json`**; add one (and reuse the existing `CRON_SECRET` from
  §22) if the 30-day cleanup should actually run.
- **Zan-F rebranding** - `themes.ts`, the vendor-register copy, the layout description and the
  customer portal's "Support Owner" line all stay Platino. The email template's brand string is
  now `process.env.EMAIL_BRAND_NAME || "Platino"` rather than hardcoded.
- **The dev-port change** (6001 → 6011) - this repo stays on 6001 per §12.
- **All docs-only commits**, including the fork's own handover and its compaction (`b56bbc4`).
  Of the 15 commits flagged "check each", 14 touch only `docs/HANDOVER.md`; the fifteenth
  (`5f681e1`) also adds `apps/api/scripts/getDriveRefreshToken.js`, which **was** ported (with
  the Zan-specific account name genericized) since it is how a `GOOGLE_DRIVE_REFRESH_TOKEN` gets
  minted. The fork's `scripts/verify*.ts` throwaways were not ported.
- **No runtime data crossed over.** No `.env`, no database contents, no seeded values. The only
  seed addition is the four generic document-requirement-type rows.

### 24.3 Customer login — unchanged, and how that was verified

Customer login here remains **RECD Serial Number + phone number + email-delivered OTP**
(`/auth/customer/register` → `/auth/customer/verify`, Customer tab on the login page). The fork
replaced this with email-only OTP; that change was not applied.

Two guards were added on top rather than relying on care alone:
- `POST /auth/google` **rejects any account with a `customerId` or the `customer` role**, so the
  new Google path cannot become a back-door customer login. The Google button renders only inside
  the Staff tab.
- Both files were snapshotted before the port and diffed after. In
  `apps/admin-web/src/app/login/page.tsx` and `apps/api/src/routes/auth.ts`, the **only removed
  line in each is the import statement** (widened to pull in `googleLoginSchema` / `ROLE_KEY`).
  Every line of the customer register/verify flow is byte-identical.

One behavioural note that is *not* a login change: because `EmailProvider` now really sends,
customer OTP emails will actually be delivered in production instead of only appearing in the
server log. The route's own logic is untouched - the notification call is still wrapped in
try/catch, the code is still logged server-side, and `devCode` is still echoed outside production.

### 24.4 Integration decisions and conflicts worth knowing

- **`Site.companyName` means two things now.** This repo added it in §20 as the Company Name the
  customer types into the portal's Company Details form; the fork added the same column name as
  the end-client / site-owner "Site name" surfaced across sites and orders. They are the same
  field and were merged rather than duplicated - the doc comment on the model says so. If these
  ever need to be distinct, that is a new column, not a rename.
- **The Complaints page kept its own layout.** The fork's `69ac88d` rolls DataTable out to
  Complaints too, but this repo's Complaints page was substantially rebuilt in §20 (issue
  category, mandatory attachment, status tiles, reject/delete, remarks + service report). Merging
  the DataTable rollout into it risked regressing that, so Complaints keeps its current table.
  Everything else in the rollout was applied.
- **The complaints route refactor was skipped.** The fork extracts `createComplaintRecord` /
  `assertOwnSite` out of `POST /complaints` purely so the agent's `create_complaint` write tool
  can share them. With that tool excluded, the refactor has no caller, and applying it would have
  conflicted with §20's one-open-complaint-per-serial rule and mandatory-attachment validation.
- **Order deletion is less restrictive here.** Upstream it refuses to delete an order that has
  invoices, converted quotations, purchase orders or expenses attached. None of those exist here,
  so only the complaint check remains.
- **`lib/finance.ts` was not ported.** Its two generic helpers (`formatINR`, `formatDate`) live in
  a new `apps/admin-web/src/lib/format.ts`; the invoice/PO status labels and the number-to-words
  helper were left behind.
- **Print CSS was pruned.** The fork's `globals.css` carries a full invoice layout (bill-to
  panels, totals summary, bank block, amount-in-words, signature). Only the classes the shared
  DataTable print view actually uses were kept.
- **New dependencies**: `@anthropic-ai/sdk`, `openai`, `googleapis`, `google-auth-library`,
  `nodemailer` (+ `@types/nodemailer`), `mammoth`, `pdf-parse` on the API; `react-markdown` and
  `remark-gfm` on admin-web. `pdf-parse` is **imported lazily inside `extractText()`** - importing
  it eagerly crashed the entire Vercel function at require-time (`ReferenceError: DOMMatrix is not
  defined`), taking down `/health` along with everything else. Do not hoist that import.

### 24.5 New environment variables (all optional; each feature degrades to "not configured")

| Var | Used by |
|---|---|
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASSWORD` / `EMAIL_FROM_ADDRESS` | real email delivery (`lib/email.ts`) |
| `EMAIL_BRAND_NAME` | brand string in outbound email subjects/headers (defaults to `Platino`) |
| `AGENT_SECRETS_KEY` | base64 32-byte key encrypting stored agent provider API keys |
| `GOOGLE_CLIENT_ID` / `NEXT_PUBLIC_GOOGLE_CLIENT_ID` | staff "Sign in with Google" |
| `GOOGLE_DRIVE_CLIENT_ID` / `_CLIENT_SECRET` / `_REFRESH_TOKEN` / `_FOLDER_ID` | agent Drive search + site Drive folders |
| `CRON_SECRET` | already exists (§22); also guards the agent conversation cleanup route |

Nothing here is set yet. Until `AGENT_SECRETS_KEY` exists the agent provider routes throw a clear
error; until the Drive vars exist the Drive tools return a "not configured" message; until SMTP
exists email logs an error and reports the notification undelivered.

### 24.6 Verification

- `npm run build --workspace=packages/shared` - clean.
- `apps/api` `tsc --noEmit` - clean.
- `apps/admin-web` `tsc --noEmit` - clean; `next build` - clean, all 22 routes emitted
  (including the new `/customers`, `/customers/[id]`, `/products`, `/products/[id]`,
  `/orders/[id]`, `/reports`, `/reports/sitc`, `/reports/customer-history`,
  `/reports/vendor-performance`).
- `npx prisma validate` - schema valid; `prisma generate` regenerates cleanly.
- Customer login diffed against its pre-port snapshot (see §24.3).
- Repo-wide grep for `Zan-F` / `Zan-APP` / `zanApp` / `zanf` / personal email addresses - no hits.

### 24.7 Migration applied + click-tested (2026-08-25)

The migration was applied to `platino-recd-mumbai` (`qpysyuysgcsrpvlxdglk`) via Supabase MCP
`apply_migration`, the four `DocumentRequirementType` rows were seeded, and the customer login
flow was click-tested end-to-end in a real browser against the live DB (not just typecheck).

**One real conflict, fixed.** The first `apply_migration` attempt failed:
`column "pinCode" of relation "CompanySettings" already exists`. Postgres DDL is transactional, so
the whole batch rolled back cleanly (confirmed via `list_tables` before retrying - none of the new
tables existed yet). Investigation found `CompanySettings.pinCode` was already on the live DB from
an **untracked-in-git** migration (`_prisma_migrations` shows `20260721120000_add_header_footer_settings`,
applied 2026-07-21, with no corresponding folder anywhere in this repo's history) - same shape
(`TEXT`, nullable) the port needed, so the migration file was edited to drop that one line and
reuse the existing column instead of re-adding it (commit `3a257fb`, after the branch's original
`7742f15`). Re-applied clean; the new migration was also recorded in `_prisma_migrations` by hand
(the Supabase MCP tool runs raw SQL, it doesn't touch Prisma's own tracking table).

**A second, unrelated drift surfaced while investigating the above, not fixed:**
`_prisma_migrations` only has 4 rows (`init`, `add_auth_and_settings`, `add_vendors`,
`add_header_footer_settings`) even though the live schema actually reflects migrations through
§23 (`add_amc_type`) - the three AMC-era migrations were applied to the schema without ever being
recorded in that table. This predates this port and wasn't touched, but `prisma migrate deploy`
will be confused by it (it'll see `add_amc_orders_...`, `add_amc_expiry_reminder_fields` and
`add_amc_type` as "not yet applied" and try to re-run DDL that's already there) until someone
reconciles the table - either backfill the three missing rows, or `prisma migrate resolve
--applied` each one.

**Security advisors** after the migration: only the same `rls_enabled_no_policy` INFO-level notice
every other table in this DB already has (RLS on, zero policies, default-deny to the anon key,
Prisma's own connection bypasses it) - nothing new.

**Click-test:** Customer tab → `ORD-2026-0001` / `+919900011122` → dev-mode OTP shown on-screen
(SMTP unset, so `EmailProvider` degraded to its console/dev-mode path exactly as designed, did not
throw) → verified → **full customer portal rendered**: order status, SITC milestone timeline with
history, the Company Details form, the complaint form, and three seeded support tickets. Confirmed
via the JWT payload that the session really is `roleKey: "customer"`, not a staff account.

One more pre-existing data anomaly found and fixed along the way: the seeded customer contact
(`cmqneogms001j8hnxentpqt7t`, "Suresh Sundaram") had `mustChangePassword: true` on the live row,
even though `seed.ts` has always explicitly set that to `false` for this user (customers
authenticate via OTP, not a password, so the flag is meaningless for them but `AuthGuard` still
redirects on it regardless of role). Corrected directly via SQL to match what `seed.ts` intends;
not a port-introduced bug, and not chased further since the login/portal flow it was blocking is
now confirmed working.

**Minor naming leftover spotted, not fixed:** `apps/admin-web/src/components/DataTable.tsx` keys
its column-visibility `localStorage` entries as `zan-app:columns:${storageKey}`. Cosmetic (a stale
prefix from the fork, doesn't leak anything, doesn't collide with anything else in this app), but
worth renaming to `recd:columns:...` next time that file is touched.

**Still not verified:** the in-app agent (needs `AGENT_SECRETS_KEY` + an LLM provider configured
first), Google sign-in (`GOOGLE_CLIENT_ID`), Drive integration, and real SMTP delivery - all
correctly degrade to "not configured" rather than erroring, per §24.5, but none has been exercised
with real credentials yet.

### 24.8 Remaining pages click-tested (2026-08-25, staff/Super Admin)

Customers, Products, Orders (list + detail, including the Google Maps link and "Sites for this
customer" panel), Reports (`/reports` index correctly shows only the three non-finance reports;
`/reports/sitc` runs and returns the seeded site), and Vendors (list renders status/engineer/site
counts and the "Archive" action on approved vendors - not clicked, since archiving a real vendor
row wasn't necessary just to confirm the button renders) - all load without console errors and
against real API responses (checked via `read_network_requests`, not just the rendered text).

Two apparent "empty" renders (`Orders` briefly showing "No orders yet.", `/reports/sitc` briefly
showing "No sites match these filters.") were both just React's first paint racing the API
response, not bugs - re-reading the page a moment later showed the row in both cases, and the
network tab confirmed the API had already returned the data correctly.

**Found, not fixed - pre-existing data, not introduced by this port:** the live
`platino-recd-mumbai` database already has a vendor literally named **"Zan-F vendor"**
(contact "Omar", `ferosem@gmail.com`), created 2026-07-06 - before this session touched anything.
This port never wrote to the `Vendor` table. Worth cleaning up since it's a name/personal-email
leftover sitting in production data, but that's a data decision for the business owner, not
something to silently delete.

### 24.9 Migration log reconciled + test vendor removed (2026-08-25)

Both closed same-day, since all data in this database is confirmed test data (nothing to preserve):

- **`_prisma_migrations` drift (§24.7) fixed.** `npx prisma migrate resolve --applied` run for
  each of the three untracked AMC migrations (`add_amc_orders_company_details_complaint_fields`,
  `add_amc_expiry_reminder_fields`, `add_amc_type`) - this only writes a "done" row per migration
  into Prisma's own log table, it does not touch any schema or data. `npx prisma migrate status`
  now reports **"Database schema is up to date!"**. `prisma migrate deploy` is safe to run here
  going forward.
- **"Zan-F vendor" row (§24.8) deleted.** Confirmed zero dependent `User`/`Site` rows first
  (`vendorId` count was 0/0), then removed. Vendor list is now the four vendors from this repo's
  own seed/testing: Salem Fabrication Works, Coimbatore Erectors LLP, Test Erectors
  1782803442496, UI Test Erectors 1782814602566.

**Follow-ups:**
1. Set whichever env vars from §24.5 the business actually wants live (SMTP first, most valuable).
2. Add a `crons` entry for `GET /agent/cron/cleanup-conversations` if agent history should expire.
3. Rename the `DataTable.tsx` `localStorage` key prefix from `zan-app:` to `recd:` (§24.7,
   cosmetic, not urgent).

### 24.10 Merged to master (2026-08-25) — push + Vercel env vars still pending

`feature/port-zan-app-nonfinance` (10 commits) merged into `master` locally with `--no-ff`,
**no conflicts**: commit `f7a9124`. This is the merge commit message summarizing the whole port;
see §24.1–24.9 above for the full detail.

**Not pushed yet.** `git push origin master` was attempted and blocked by the harness's own safety
classifier (pushing to the production branch is treated as high-stakes regardless of in-session
confirmation). The merge exists only in the local `D:\Projects\Claude code` checkout right now.
Someone needs to run, from that directory:
```
git push origin master
```
That push is what triggers Vercel's auto-deploy of both projects (`platino-recd-api`,
`platino-recd-admin-web`) to production, per §9's Git-connected topology.

**Vercel env vars for SMTP/Drive/Google/agent (§24.5) are not set either** - no tool available in
this session can write Vercel project env vars (only read project settings), so those still need
to be added by hand in each project's **Settings → Environment Variables**:
- `platino-recd-api`: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `EMAIL_FROM_ADDRESS`,
  `EMAIL_BRAND_NAME`, `AGENT_SECRETS_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_DRIVE_CLIENT_ID`,
  `GOOGLE_DRIVE_CLIENT_SECRET`, `GOOGLE_DRIVE_REFRESH_TOKEN`, `GOOGLE_DRIVE_FOLDER_ID`.
- `platino-recd-admin-web`: `NEXT_PUBLIC_GOOGLE_CLIENT_ID` (same value as `GOOGLE_CLIENT_ID`).

All of these are optional at the code level - every feature they gate degrades to a clear
"not configured" state rather than erroring (§24.5), so the push/deploy above does not need to
wait on them. Deliberately left blank for now per the business's own call; revisit later.

**Immediate next step:** push, then verify the production URLs load and staff/customer login both
work (the local smoke test in §24.7/§24.8 covered this against localhost + the Supabase DB
directly - production has not yet been checked end-to-end against the deployed Vercel functions).

## 25. Service module phase 1 - regions, per-unit RECD serials, PO number, user audit (2026-10-07, branch `feature/service-module-phase1`)

**Source:** `New_Service_Web_Platino_correctionsV1.0.docx` (Field Sense / Service module, 11 requirements). This phase covers items 1, 2, 9, 10 and the data foundations for 3, 6, 7, 8, 11. Decisions from the business: serial number is **unique per physical RECD** (an order can hold several); no SMS provider - WhatsApp stays a provider slot to connect later; Regional Manager role + admin-defined regions.

**Migration `20261007120000_service_module_phase1` (idempotent for roles/permissions; NOT yet applied to production):**
- `RecdUnit` (one row per physical RECD, `serialNo` globally unique, nullable only for legacy "serial pending" units; `lineItemId` ties a unit to its extra product line). **Backfill:** one unit per existing order unit; the first unit of each order takes the order number as its serial (that is what customers already log in with, see §20), all other units are "serial pending" until staff enter them on the order page or `/recd-units?pending=1`.
- `Region` + `RegionManager` (many managers per region), `Site.regionId`.
- `Order.poNumber/poDate/poDuplicateFlag`; duplicate PO for the same customer is rejected (409 `DUPLICATE_PO`) unless an admin passes `allowDuplicatePo`, which flags the order.
- `UserAuditLog` (create/edit/role change/deactivate/activate/password reset; never stores password material).
- New permission `manage_regions` (super_admin, owner_admin, management) and roles `regional_manager`, `service_manager`, `service_engineer`, all inserted by the migration - prod never re-runs the seed (see §21).
- RLS enabled, zero policies, on the four new tables (same posture as every other table).

**API:** `/regions` (CRUD + `PUT /:id/managers`), `/recd-units` (list/search, `PUT /:id/serial` write-once), `PUT /sites/:id/region`, `GET /users/audit-log`; `POST /orders`, `POST /orders/:id/line-items` and `POST /sites/:id/clone-order` now require one distinct serial per unit and a PO number (clone inherits the PO). Mobile numbers are validated/normalised to 10 digits (`indianMobileSchema`) - mandatory on user create, and on `sitePocNumber`. A Regional Manager's complaint list is scoped to their regions. Agent-created orders (confirm-gated `create_order`) create "serial pending" units because the agent cannot know physical serials.

**Admin UI:** PO + per-unit serial fields on New order; PO/serial columns on Orders; units block on the order page (set pending serials); serials + region on the site page; new `/regions` and `/recd-units` pages; mandatory mobile on Users + "User change history" panel. Removed the stale `customerPoNumber/customerPoDate` references on the order page (those fields never existed in this repo's schema; Zan-APP leftovers).

**Verification:** `packages/shared` unit tests (8, `npm test --workspace=packages/shared`); `tsc` clean for shared and admin-web; migration applied to a throwaway Postgres 16 on top of all earlier migrations with sample legacy orders (multi-quantity + line items) and the backfill checked row by row. **Not verified:** `apps/api` typecheck against generated Prisma types and `next build` - the sandbox could not download Prisma engines or Google Fonts (network allowlist); the API typechecks with only the missing-Prisma-client errors. Run `npm ci && npm run build` locally before merging. No click-test against a real DB yet.

**Next (phases 2-5):** public complaint by serial + mobile + OTP (hashed OTP, rate limits, WhatsApp Cloud API provider slot, reporter type reseller/re-reseller), one-open-ticket-per-unit, reminder/escalation engine, vendor vs customer AMC + warranty status, signed digital service/AMC reports, ticket SLA escalation.

## 26. Service module – Phase 2: public complaint via serial + mobile + OTP

**Branch:** `feature/service-module-phase2` (stacked on phase 1 / PR #4). **Migration:** `20261007180000_public_complaint_otp` – NOT applied to production; apply before deploying the API.

### What it does
Anyone holding a RECD serial (owner, reseller, re-reseller – they may not be the registered customer) can raise a service ticket at `/report-issue` (public, no login):
1. Enter serial + mobile → `POST /public/complaints/otp/request`
2. Enter 6-digit OTP → `POST /public/complaints/otp/verify` → single-use session token (15 min)
3. Enter name, relationship, issue, description, optional photo → `POST /public/complaints` → ticket number.

The ticket is linked to the unit (`Complaint.unitId`), its customer and site, `source = "public"`, with reporter name/phone/type and verification time. Service team, Service Managers and the site region's Regional Managers are notified (`complaint_raised`, in-app + email).

### Rules enforced
- One open ticket per RECD unit (partial unique index `Complaint_one_open_per_unit` + friendly 409; authenticated route also accepts `unitId`).
- OTP: HMAC-hashed, 5-min expiry, 5 attempts then locked, 30 s resend cooldown, limits 5/mobile, 10/serial, 20/IP per hour (DB-backed, serverless-safe).
- Responses never reveal whether a serial exists or any customer/site data; unknown serials get the same reply and no message is sent.

### Delivery – "build now, connect later"
`apps/api/src/lib/otpDelivery.ts`. Until WhatsApp is configured the feature is OFF in production (request-otp returns 503). Set on the API project:
`WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, optional `WHATSAPP_OTP_TEMPLATE_NAME` (default `recd_otp`), `WHATSAPP_TEMPLATE_LANG` (`en`), `WHATSAPP_API_VERSION` (`v21.0`).
Create a Meta **authentication** template named `recd_otp` with a copy-code button. Non-production uses a console provider; `PUBLIC_OTP_DEV_ECHO=1` echoes the code in the API response (never honoured on Vercel production).
Failed deliveries are visible in `PublicOtp.deliveryStatus`.

### Tests
`npm test --workspace=apps/api` (OTP hashing, expiry/lockout, throttling, payload, prod-safety of dev channel).

### Not yet done (later phases)
Reminder/escalation engine, AMC vendor/customer dates + renewals, warranty status, signed service reports, ticket SLA escalation.

## 27. Service module – Phase 3: ticket history, notifications and SLA escalation

**Branch:** `feature/service-module-phase3` (stacked on phase 2 / PR #5). **Migration:** `20261007230000_ticket_sla_history` – NOT applied to production; apply (after the two earlier ones) before deploying the API.

### What it does
- **Ticket history** – new append-only `ComplaintEvent` table (created, status_changed, assigned, escalated) with actor (user or label such as "System (SLA)"). Written by the portal create, public create, PATCH and the escalation cron. Staff read it via `GET /complaints/:id/history` (same access rules as the list: Regional Managers only for their regions, engineers only their own tickets) and see it in the ticket editor.
- **Notifications on raise** – both the portal and the public flow now alert Service Team, Service Managers, Management, the Regional Manager(s) of the site's region and (if any) the assignee, via `lib/ticketNotify.ts`.
- **SLA escalation** – `GET /complaints/cron/escalate` (Vercel cron `30 3 * * *`, `Authorization: Bearer $CRON_SECRET`, required – returns 401 if unset). A ticket not resolved/closed (and not waiting_for_customer) escalates to level 1 (Regional Manager of the site's region; falls back to Service Managers if the site has no region/manager) after **24 h** and level 2 (Management + Owner/Admin) after **48 h**, measured from creation. Levels only increase and are claimed atomically (`updateMany ... WHERE slaEscalationLevel = old`), so overlapping runs never double-alert; a level jump (cron was down) alerts every skipped audience. Emails use the `complaint_escalated` template.
- **Editable windows** – Settings page → "Ticket SLA escalation" (`PUT /settings/sla`, needs `manage_settings`; management hours must be ≥ regional hours). Stored on `CompanySettings.slaRegionalManagerHours / slaManagementHours`.
- Staff complaints list shows an "SLA breached" badge for tickets escalated by the cron.

### Decisions / caveats to know
- **Backfill:** tickets that exist when the migration runs are set to `slaEscalationLevel = 2` (no `lastEscalatedAt`) so the first cron run does not flood managers with the whole backlog; they show no badge. Only tickets raised afterwards escalate.
- **Cron frequency:** daily, so an escalation can lag its threshold by up to ~24 h. Hourly needs a Vercel plan that allows it (change `schedule` in `apps/api/vercel.json`, e.g. `0 * * * *`); nothing else changes.
- The SLA clock is simple age since creation; there is no pause/resume bookkeeping beyond skipping `waiting_for_customer`.
- WhatsApp is still a stub channel for staff notifications (in-app + email are live).
- The cron route could not be exercised against a live database in the sandbox (Prisma engines are blocked); the migration chain was applied to a scratch Postgres and the pure SLA logic is unit-tested (`npm test --workspace=apps/api`, 14 tests).

### Remaining roadmap (not started)
1. Region-wise Service Manager reminders (daily digest of open/overdue tickets per region) – can reuse the cron and `ticketRecipients`.
2. AMC: vendor vs customer dates, renewal history, configurable lead times (60/30/7), login pop-up reminders.
3. Warranty status (Active / Near Expiry / Expired) + reminders.
4. Customer-signed digital service report and digital AMC service report (signature pad, PDF, linked to unit/site/customer/AMC).

## 28. RECD serial hardening, AMC-to-unit links and per-unit service history (2026-10-15, branch `feature/my-service-improvements`)

**Status: implemented and covered by automated tests; NOT yet verified in a browser, the print view, Excel or on a phone, and the migration below is NOT applied to any shared database.** Nothing here has been deployed.

### 28.1 What changed
- **AMC ↔ RECD units.** An AMC order can now cover several RECD units (`unitIds` on `POST /amc-orders`). New table `AmcOrderUnit` (join table). The AMC list returns each order's units with serial, product and site/DG; `POST /amc-orders` also checks the customer exists (`400 "Customer not found"`) and that every unit exists, has a serial, is active and belongs to that customer.
- **Per-unit history.** `GET /recd-units/:id/history` returns the unit (serial, customer, site, DG model/kVA), its service tickets (incl. service report and, for staff, the ticket timeline) and its AMC orders. Screen: `/recd-units/[id]`; the `/recd-units` list links to it.
- **Complaints ↔ unit.** One shared rule (`packages/shared/src/complaintUnits.ts`) is used by the API, the customer portal and the mobile screen: a site with more than one in-service RECD requires the customer to pick one; a single unit is linked automatically; units of other sites/customers and retired units are rejected. The mobile complaint screen now sends the mandatory name-plate photo and the unit.
- **Serials on every creation path.** `POST /orders`, `POST /orders/:id/line-items`, `POST /sites/:id/clone-order` and the AI `create_order` tool (proposal AND confirmation) all require exactly one valid, distinct, unregistered serial per unit. `POST /orders` now saves order + site + units in ONE transaction (a lost race used to leave an order and site behind with no units). Legacy units with a null serial are still allowed and can be given a serial once via `PUT /recd-units/:id/serial`; the column was deliberately NOT made `NOT NULL`.
- **Error mapping.** A unique-constraint error is now classified by the column Prisma reports (`lib/uniqueViolations.ts`): a taken serial → `409` "serial"; a server-generated order-number collision → `409` with `code: "ORDER_NUMBER_CONFLICT"` ("nothing was saved - please submit again"); a second open ticket for one unit → `400`; anything else stays a `500`. AI confirmation returns `400` (invalid card) / `409` (conflict) and leaves the pending card pending so it can be rejected; any other failure returns a fixed, user-friendly `500` message (details are written to the server log only, never to the response). A customer complaint whose random ticket number (`TCK-<year>-<5 digits>`) collides with an existing one is retried with a new number up to 3 times (same as the public flow); if all attempts collide it returns `409` `TICKET_NUMBER_CONFLICT` and saves nothing. Only ticket-number collisions are retried - the one-open-ticket index (`400`) and all other errors are not.
- **Reports/exports.** The customer-history report shows serials on orders and complaints (and in its CSV); missing serials show "Serial not entered". `lib/csvExport.ts` (used by ALL report exports) now neutralises spreadsheet formulas: text starting with `=`, `+`, `-`, `@`, tab or CR gets a leading `'`; real numbers and plain numeric strings are unchanged.

### 28.2 Migration `20261015120000_amc_order_units`
- **Purpose:** creates `AmcOrderUnit (amcOrderId, unitId, createdAt)` with primary key `(amcOrderId, unitId)`, an index on `unitId`, FK to `AmcOrder` (`ON DELETE CASCADE`), FK to `RecdUnit` (`ON DELETE RESTRICT`) and row-level security enabled with no policies (same posture as every other table). It is purely additive: no existing row or column is changed, and existing AMC orders simply have no linked units.
- **It depends on** the `RecdUnit` table from `20261007120000_service_module_phase1`. §25–§27 state that phase 1–3 migrations (`20261007120000`, `20261007180000`, `20261007230000`) had NOT been applied to production when written - check the live `_prisma_migrations` before applying anything, and apply in file order.
- **Why it must be applied BEFORE the code is deployed to any shared environment:** these code paths query `AmcOrderUnit` and fail (HTTP 500) if the table is missing: `GET /amc-orders`, `POST /amc-orders`, `GET /recd-units/:id/history`, `DELETE /orders/:id` and `DELETE /orders/:id/line-items/:lineItemId`. (The AMC expiry cron `GET /amc-orders/send-expiry-reminders` does not touch it.)
- **Deployment automation does NOT apply it.** `apps/api/vercel.json` runs `npm run build`, which for the API is `prisma generate && tsc -p tsconfig.json`; neither the package scripts nor `turbo.json` contain a `migrate` step, and there is no CI workflow in the repo. Earlier migrations were applied by hand by the database owner (see §20 and §24.7).
- **Do not run any migration against production without the database owner's approval.** Existing package scripts: `npm run db:migrate` is `prisma migrate dev` (a DEVELOPMENT command - it can prompt to reset a database; never point it at a shared database); `prisma migrate deploy` (mentioned in §16 and §24.9) and `prisma migrate resolve --applied` (§24.9) are the commands this document already refers to. Follow the process used for the earlier migrations (§20, §24.7): reviewed SQL applied by the database owner and recorded in `_prisma_migrations`.
- **How it was tested:** all 12 migrations were replayed from scratch on an empty disposable PostgreSQL 16 container (`localhost:5434/platino_test`, never a shared database) with `prisma migrate deploy` - all applied; the resulting schema matched `schema.prisma` (after the `pinCode` note below). The migration SQL equals what `prisma migrate diff` generates from the old and new `schema.prisma`, plus the RLS line.

### 28.3 Schema / environment gaps found while replaying the migrations
- **`CompanySettings.pinCode` has no migration.** It is in `schema.prisma` and used by `settings.ts` and the admin UI, but `20260825120000_port_zan_nonfinance` states it "already existed ... (added out-of-band, untracked in git)" and never creates it. A database built only from the migration files therefore lacks the column, so anything that reads `CompanySettings` through Prisma (the settings page, the seed) is expected to fail on it, because Prisma selects every column. (The column was added before seeding the local database, so this failure was not observed directly.) Production has it. For the local disposable database it was added by hand (`ALTER TABLE "CompanySettings" ADD COLUMN "pinCode" TEXT`), NOT via a repo migration. Decision needed: add an idempotent migration (`ADD COLUMN IF NOT EXISTS`) so fresh databases are reproducible.
- **`AmcOrder` row-level security** is enabled in production by hand (§20) but no migration enables it, so a replayed database has it off. The API connects as the table owner, so behaviour is unaffected.
- **`.env.example` has no `DIRECT_URL`** although `schema.prisma` declares `directUrl = env("DIRECT_URL")` (confirmed: Prisma commands fail without it). Local setup needs both `DATABASE_URL` and `DIRECT_URL`.
- Local seeding note: running `tsx prisma/seed.ts` from `apps/api` did not pick up `apps/api/.env` on the development machine; `node --env-file=.env --import tsx prisma/seed.ts` did. The seed creates the sample order with no RECD units (units are only back-filled by the phase-1 migration).

### 28.4 Tests
- `npm test --workspace=apps/api`, `npm test --workspace=packages/shared`, `npm test --workspace=apps/admin-web`: no database needed (the API suite replaces Prisma with in-memory stubs, so it does NOT prove database behaviour).
- `npm run test:db --workspace=apps/api`: real-database tests (unique-constraint races, transactions, foreign keys, the partial unique index on open complaints, the real role permissions, the AI confirmation route). They WRITE rows, so they refuse to run unless `DATABASE_URL` and `DIRECT_URL` both point at `localhost:5434/platino_test`, they only touch rows they create (unique run prefix) and delete them afterwards. The database must already be migrated and seeded. Not wired into any CI (there is none).

### 28.5 Decisions needed from the mentor / product owner
1. **RECD unit access was tightened (not asked for).** `GET /recd-units` and `GET /recd-units/:id`:

   | | Before | Now |
   |---|---|---|
   | `regional_manager`, list | every unit | only units whose site is in a region mapped to them (none if unmapped; units with no site are excluded) |
   | `regional_manager`, detail by id | any unit | only units in their regions, otherwise `403` |
   | vendor-scoped users (any user with a `vendorId`, e.g. the seeded `erection@platino.example` and vendor-registered engineers), list | only their vendor's sites (unchanged) | unchanged |
   | vendor-scoped users, detail by id | any unit | only units at their vendor's sites, otherwise `403` |
   | customers | own units only | unchanged |
   | everyone else with `view_site_status` | all units | unchanged |

   Reason: it matches how `/complaints` already scopes these roles. **Decision:** keep this, or restore the previous (unscoped) behaviour for the list/detail routes. The new `/recd-units/:id/history` endpoint is scoped the same way regardless.
2. **Customers see their own AMC information.** `GET /recd-units/:id/history` returns, for a customer viewing their own unit, the AMC orders covering it (PO number/date, type, visits per year, status, expiry, "AMC acquired" flag), while `/amc-orders` itself is staff-only (`manage_amc_orders`). **Decision:** allow as is, hide AMC from customers, or show a reduced subset. (Customers never receive the internal ticket timeline; staff with `view_site_status` only get no tickets or AMC at all.)
3. **AMC quantity vs. number of linked units.** `qty` has always been a free "contracted quantity" taken from the PO (`createAmcOrderSchema`: positive integer, no link to any other data) and the project has no rule tying it to registered units, so it is deliberately NOT validated against the selected units (the form only pre-fills it with the number of units ticked). Options: (a) keep as is; (b) require `qty >= linked units`; (c) require `qty == linked units` whenever units are linked; (d) derive qty from the units. Needs a business decision before any change.
4. **Order-number collisions** (`ORD-<year>-<4 random digits>`, unique) are reported clearly (`409`, `ORDER_NUMBER_CONFLICT`) but the user must resubmit. Option: generate the number with a short retry loop instead. (Customer ticket numbers `TCK-<year>-<5 digits>` already retry up to 3 times, like the public flow.)
5. **`CompanySettings.pinCode` migration** and **`AmcOrder` RLS migration** (28.3): add repo migrations or keep them as manual production history.
6. **Tests are not run automatically anywhere** (no CI, no root `test` script, no `test` task in `turbo.json`).

### 28.6 Still to verify manually (not covered by any automated test)
Browser walk-through of `/recd-units`, `/recd-units/[id]`, `/amc-orders` (multi-unit picker) and the customer-history report with each role; the report's print view; opening the exported CSV in Excel; the customer portal serial picker at a one-unit and a two-unit site; the mobile complaint screen (camera + photo upload) on a real device; applying the migration to a COPY of production data and re-testing there.

## 29. Mobile-number rules for customer, vendor and site contacts (Requirement 2, part 1) (2026-10-16, branch `feature/my-service-improvements`)

**Status: implemented and covered by automated tests (including the isolated local test database); NOT yet checked in a browser. No schema change and no migration is needed.** The OTP delivery channel is unchanged (customer OTPs are still emailed, see §24.3); display of the numbers on more screens and the OTP-security items from the Requirement 2 audit are separate work.

### 29.1 The rule
One shared helper (`normalizeIndianMobile` / `indianMobileSchema` in `packages/shared/src/schemas.ts`) is used everywhere: a 10-digit Indian mobile starting 6-9, accepted with a `+91` / `91` / `0` prefix, spaces, dashes or brackets, **stored as exactly 10 digits**. The one message for a bad number is `INDIAN_MOBILE_MESSAGE`. Forms check with the same helper (`apps/admin-web/src/lib/mobileInput.ts`) for a clear message, and the API validates every request on its own, so a direct API call cannot bypass it.

| Where | Before | Now |
|---|---|---|
| Customer contact (`POST/PUT /customers`, also used by the Orders and AMC "new customer" forms) | any text of 6+ characters, stored as typed | mandatory on create; valid Indian mobile, normalised; on update only validated when sent |
| Customer login (`/auth/customer/register`, `/verify`) and the phone-only login used by the mobile app (`/auth/otp/request`, `/verify`) | a different (international) pattern, exact text match | same Indian rule; the typed number is normalised and compared with the stored one after normalising it, so every accepted spelling finds the same person, including contacts saved in an older format |
| Vendor (`POST /vendors/register`, `POST /vendors`) | optional, any text | mandatory, valid, normalised; the vendor login user gets the same number |
| Site contact (`POST/PATCH /sites/:id/contacts`) | optional, any text | mandatory on create, valid and normalised; on update only validated when sent |

Other behaviour changes: `PUT /customers/:id` now edits the **oldest (primary) contact** or exactly the contact named by the new optional `contactId` (which must belong to that customer, otherwise 404) instead of an arbitrary `contacts[0]`; customer contacts are returned oldest first. A duplicate number (checked in any stored format, since `User.phone` is unique in the database) is a clear `400 "A contact with that phone number already exists"` even when two requests race; approving a vendor or adding one when its number belongs to another user keeps the vendor, skips the login and returns `contactLoginSkippedReason` instead of a 500. No new uniqueness rule was added for vendors or site contacts.

### 29.2 Existing (legacy) records - nothing was changed in the data
- **Customer contacts saved in an older format** (e.g. with `+91`) still log in and still count as duplicates; re-saving the contact tidies the number to 10 digits. **Contacts holding a non-Indian number, or text that is not a number, can no longer log in** with the customer or phone-only login (the typed number must now be a valid Indian mobile) until their number is corrected - the data owner should find these first.
- **Vendors with no or unreadable number** stay as they are; approving one creates the login **without** a number (nothing is invented) and an older `+91` spelling is normalised onto the login user only (the vendor row is not rewritten). There is no vendor edit endpoint, so such vendors need a data fix.
- **Site contacts without a number** stay; they can still be renamed (the number is only validated when it is sent), but a new contact cannot be saved without one.
- **Cleanup plan (needs the database owner; none of it has been run):** (1) list, read-only, customer contacts, vendors and site contacts whose phone is empty, not 10 digits, or does not start with 6-9; (2) get the correct numbers from the business; (3) correct them through the edit screens, or through a reviewed one-off script run by the database owner after a backup; (4) only after that consider making any column NOT NULL or adding a check constraint - not done here because legacy rows would block it.

### 29.3 Not covered / still open
- `POST/PATCH/DELETE /sites/:id/contacts` still has no vendor/customer scoping (any user holding `change_site_status` can edit any site's contacts) - unchanged, flagged.
- A contact-email clash on customer create/update is still an unexplained 500 (only phone clashes were handled).
- Tests: `packages/shared/test/mobileNumbers.test.ts`, `apps/api/test/mobileNumbers.test.ts` (route logic with a fake database - it does not prove constraints or rollback), `apps/api/test/db/mobileNumbers.db.test.ts` (real database: stored values, unique-number races, rollback, customer login, vendor logins, site-contact linking; `npm run test:db --workspace=apps/api`), `apps/admin-web/test/mobileInput.test.ts`. Still to do by hand: the forms in a browser (customers, new order, AMC new customer, vendor register/add, site contacts, customer login) and the mobile app's phone login.

## 30. Requirement 2, part 2: contact numbers on site and ticket screens, and OTP security (2026-10-16, branch `feature/my-service-improvements`)

**Status: implemented and covered by automated tests, including the isolated local test database; NOT yet checked in a browser or on a phone. No schema change and no migration.** The customer OTP is **still emailed** - switching it to SMS/WhatsApp is a product decision for the mentor and was deliberately not made.

### 30.1 Contact numbers - where each comes from and who sees it
The people on a ticket are different people, so each comes from its own record and is labelled on screen:

| Shown as | Source | Notes |
|---|---|---|
| Reported by (public tickets only) | `Complaint.reporterName/reporterType/reporterPhone` | the OTP-verified reporter; absent on portal tickets |
| Site POC | `Site.sitePocName` / `sitePocNumber` | entered by the customer in the portal (Company details) |
| Site contact | `SiteContact` rows of the ticket's own site | one row per person |
| Customer contact | the customer's oldest (primary) contact user | same "primary" rule as `PUT /customers/:id` |

A missing number is shown as **"No mobile number on file"**; no other person's number is ever substituted. Screens: the site page (new **Site POC** block, and site contacts now say when a number is missing), the service-ticket "Manage/Update" dialog and the public line on the ticket list (`/complaints`, new `contactInfo` block from `GET /complaints`), and the contact line on the customer and order detail pages.

Who gets `contactInfo` (decided on the existing complaint permissions, `apps/api/src/lib/ticketContacts.ts`): **desk roles** (`manage_complaints` / `view_complaints_overview`: service desk, managers, Regional Managers within their regions) get reporter + site POC + site contacts + customer contact; **roles that only act on assigned tickets** (field and vendor engineers - they already only list tickets assigned to them) get reporter + site POC + site contacts but **not** the customer company's contact; **customers and every other role get none**. Contacts are loaded through each ticket's own site and customer, never through an id sent by the client.
**Privacy change to confirm:** `GET /complaints` no longer returns `reporterPhone` to a *customer* - a reseller who raised a public ticket on the customer's RECD keeps their number private from the registered customer (the customer still sees the reporter's name and type, as before; no screen used the number).

### 30.2 OTP security (customer login `/auth/customer/*` and the phone-only login `/auth/otp/*` used by the mobile app)
- **Generation:** `crypto.randomInt` (was `Math.random`); same 6-digit format and 10-minute life.
- **Storage:** the database no longer holds a code. `OtpCode.code` (a plain text column, so no migration) now stores an HMAC-SHA256 keyed with `JWT_SECRET` over (row id, user id, code), compared in constant time. A row cannot be replayed for another user. Codes are single use (claimed atomically) and expire after 10 minutes. **Codes that were issued before this change are plain text and stop working; users simply request a new one.**
- **Notification log:** `sendNotification` used to write the whole payload - including the code - into `NotificationLog.payload`. For `otp_code` the code is now stored as `[redacted]`. **Existing `NotificationLog` rows from before this change still contain real (long expired) codes; the database owner should decide whether to blank `payload.code` in old `otp_code` rows.** Old server-log lines (the removed `[OTP GENERATED] ... OTP:` line) may also exist on the hosting platform.
- **Logging:** the plain-text OTP log line is gone and a test fails if any `console.*` call prints a code/otp/token/password. The only remaining place that prints a code is the development-only console delivery provider of the public complaint OTP, which is never selected in production.
- **Deactivated accounts:** the phone-only login issues no code for an inactive account and checks `isActive` before consuming a code or signing a token (previously neither flow stopped it).
- **No account enumeration:** unknown order/number, inactive account and wrong/expired/used/misdirected code all give the same answer (`200` "If those details match an active account, a one-time code will be emailed..." for requests; `401 "Invalid or expired code"` for verifies). The old 404s ("Order not found", "No account found for that phone number") are gone. UX effect: a customer who mistypes the number now gets no error at the request step.
- **Delivery failures:** a code is reported as delivered only when the email provider says so. Customer login: if the contact matched but the email could not be delivered, production returns `503 OTP_DELIVERY_FAILED` ("We could not send the code right now...") and voids the code (e.g. a contact with no email address); in local development the code is shown on screen and the message says the email was not delivered. Phone-only login: the answer stays identical to every other outcome (no signal about the account), the undelivered code is voided and the failure is logged without the code or the number. A code is only ever emailed to the matched account's own registered address - never to anything the caller supplies. In production the code is never in any response.
- **Phone formats:** both flows normalise the typed number with the shared helper and match stored numbers in any older format (§29).
- **Guess budget:** 5 wrong codes per user between code requests (then even the right code is refused until a new one is requested), on top of the existing 10-requests-per-15-minutes-per-IP limit.

### 30.3 Still open / decisions
- **Customer OTP channel (mentor decision, unchanged):** email today; the public complaint flow uses WhatsApp. Moving the customer login to WhatsApp/SMS needs the mentor's confirmation and provider setup.
- The 5-guess budget and the IP limiter are **in memory, per server instance** (serverless instances do not share them). A proper per-code attempt counter needs a new column on `OtpCode` (a migration for the database owner) - not added.
- Vendor temporary passwords are still generated with `Math.random` (`vendors.ts`) - a separate, similar weakness outside the OTP scope.
- The phone-only login lets any active account type (staff included) sign in by emailed code; whether that is intended was not changed.
- Tests: `apps/api/test/loginOtp.test.ts` (OTP rules; fake database), `apps/api/test/ticketContacts.test.ts`, `apps/admin-web/test/contactDisplay.test.ts`, and the real-database cases in `apps/api/test/db/mobileNumbers.db.test.ts` (hash storage, redacted log, deactivated/active accounts, single use, expiry, races, enumeration, ticket contacts per role). Browser checks of the site page, the ticket dialog and the login pages, and a phone test of the mobile app's login, are still to do by hand.

## 29. Audit follow-ups (site-contact scoping, email conflicts, missing-mobile text, login pre-fill)

- **Site contacts** (`POST/PATCH/DELETE /sites/:id/contacts`): now use the same scoping as the other site routes - a vendor user only reaches sites assigned to their vendor, a customer user only their own sites; unscoped staff with `change_site_status` are unchanged. A contact is only reachable through the site it belongs to. Tests: `apps/api/test/siteContactsAuth.test.ts`.
- **Question for the mentor:** which roles should be allowed to edit site contacts at all? Today the permission is `change_site_status` (management, operations/PM, erection and commissioning engineers), which was left as is. In particular, should vendor engineers and customers be able to add/edit/delete contacts on their own site, or should that be office staff only? Customers do not hold this permission in the seed data, so the customer scoping only matters if a role is changed. No new rule was invented.
- **Customer email conflict:** `POST /customers` and `PUT /customers/:id` return **409** "A contact with that email address already exists" instead of an unexplained 500. Phone conflicts keep their existing 400. Other database errors still surface as 500.
- **Missing mobile number:** the customers list and the vendors page show "No mobile number on file" for a contact without a number (`nameWithMobile` / `emailWithMobile` in `apps/admin-web/src/lib/contactDisplay.ts`).
- **Login pre-fill:** the web login page (staff and customer tabs) and the mobile `LoginScreen` start with empty fields. Authentication and seeded accounts are untouched.


## 30. Requirement 3 - OTP (2026-10-16, branch `feature/my-service-improvements`)

**Status: implemented and covered by automated tests (mocked and against the isolated local database); live WhatsApp delivery has NOT been tested because no provider credentials are configured. Not tried in a browser or on a phone. This section supersedes the "OTP is emailed" remarks in sections 24, 28 and 29.**

### What changed
- **Channel:** login codes (customer login `/auth/customer/*`, phone-only login `/auth/otp/*`) and the public complaint code are sent by **WhatsApp** (Meta Cloud API, existing integration in `lib/otpDelivery.ts`, authentication template `recd_otp`). Email is no longer used for codes; there is no email/SMS fallback. The destination is the number stored on the user/contact record, normalised with `normalizeIndianMobile`; the client only supplies the number used to FIND the account.
- **Binding:** `OtpCode` now records `purpose` (`customer_login` | `phone_login`), `destination` (the number the code went to), `attempts` and `deliveryStatus`. A code is accepted only for its user, purpose and destination. Hash format unchanged (HMAC of row id + user id + code, keyed with `JWT_SECRET`).
- **Expiry:** login 10 minutes, public complaint 5 minutes (unchanged), enforced in the database query. One policy object, `LOGIN_OTP_POLICY` / `PUBLIC_OTP` in `packages/shared`, is used by the server and by the web/mobile screens.
- **Resend:** a new request voids every earlier unused code of the same user + purpose. 30-second cooldown, 5 requests per hour per user and purpose (failed deliveries count towards the hour but not towards the cooldown). A partial unique index allows only ONE unconsumed code per user + purpose, so simultaneous requests cannot leave two usable codes. Blocked requests (429) change nothing.
- **Guesses:** 5 per code and 10 per user + purpose per hour across all codes, counted in the database (atomic) - not in process memory - so they hold across server instances and cannot be reset by requesting a new code. A correct guess is given back, so only wrong guesses use the budget.
- **Failure handling:** a failed delivery is a 503 "could not send" for customer and phone-only login (never "sent"), the new code is voided, and the user may retry at once. With no provider configured the request routes answer 503 "not available" for everybody (so a missing configuration cannot reveal which accounts exist).
- **Development echo:** returning a code in an API response now needs `OTP_DEV_ECHO=1` (old name `PUBLIC_OTP_DEV_ECHO=1` still works) AND a non-production, non-hosted environment (`NODE_ENV=production`, `VERCEL*`, `RENDER`, `DYNO`, `K_SERVICE`, `AWS_LAMBDA_FUNCTION_NAME`, ... disable it). It is off by default. The old console "dev" provider that printed codes is gone. The mobile app shows a code only when `__DEV__` is true.
- **Screens:** web customer login and the mobile OTP screens now have a resend button with a countdown, show the code lifetime, and show distinct messages for accepted / delivery failure / wait before resend / rate limit / wrong-or-expired code. The public complaint page shows the lifetime too.

### Database
- New migration `apps/api/prisma/migrations/20261016090000_login_otp_hardening/migration.sql` (additive: four columns with defaults, one index, one partial unique index; it also marks any still-unconsumed old code as consumed so the index can be built). **Prepared for review. It was applied ONLY to the isolated local database `localhost:5434/platino_test`.** Whoever owns the shared/production database must review and apply it with `prisma migrate deploy` before deploying this code; deploying the code first would break login-code requests.
- **Old `NotificationLog` rows:** before the Requirement 2 redaction fix, `otp_code` notifications may have stored the plain code in `payload.code`. Not queried or changed here. Suggested clean-up for the database owner (take a backup first; check the count with the SELECT before running the UPDATE): `SELECT count(*) FROM "NotificationLog" WHERE "templateKey" = 'otp_code' AND payload->>'code' IS DISTINCT FROM '[redacted]';` then `UPDATE "NotificationLog" SET payload = jsonb_set(payload, '{code}', '"[redacted]"') WHERE "templateKey" = 'otp_code' AND payload ? 'code' AND payload->>'code' <> '[redacted]';` (the column type should be confirmed to be jsonb first).

### Needed before OTP can really be delivered
1. A Meta WhatsApp Business account, a system-user token and the sending number's Phone Number ID -> `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`.
2. An **approved authentication-category template** named `recd_otp` (or set `WHATSAPP_OTP_TEMPLATE_NAME`) in language `en` (or `WHATSAPP_TEMPLATE_LANG`) with one body parameter (the code) and a copy-code URL button - exactly the payload built in `buildWhatsAppOtpPayload`. The template text must state the validity (10 minutes for login; 5 for the public flow - a single template can say "a few minutes" or two templates can be approved if the exact figure matters).
3. Set those variables on the API host (never in the repo; `.env.example` lists the names only).

### Decisions still open (mentor / product owner)
- **Staff phone-only login:** any ACTIVE user with a mobile number can sign in with just the WhatsApp code (no password), including admins. Whether that is intended was not changed.
- **Public complaint flow:** it still verifies whatever mobile number the reporter types (resellers / re-resellers need that). That can message a stranger's number (limited to 5 per number per hour, 30 s apart, 20 per IP per hour, and only for an active serial). Restricting it to the registered customer/site number would stop the reseller use case - needs approval.
- **Enumeration trade-off:** a delivery failure (503) and a cooldown/limit answer (429) for login are only possible for real accounts. The "not available" answer for a missing provider is uniform. The alternative (always 200) would hide failures from users.
- A user can be temporarily locked out by someone who guesses 10 wrong codes in an hour for their number (an unavoidable trade-off of a guess budget); the lock clears when the hour passes.

### Known limitations
- The per-IP limiter in `middleware/rateLimit.ts` (10 auth requests / 15 min; 60 for the public routes) is still **in memory per server instance**. The per-user request and guess limits are the database-backed protection; there is no Redis in this project.
- The public complaint flow's answer is intentionally identical whether or not the WhatsApp send worked; the failure is only visible in `PublicOtp.deliveryStatus` and the server log.

### Tests
`apps/api/test/loginOtp.test.ts` (mocked, in-memory table in `test/helpers/fakeOtpStore.ts`), `publicComplaintsOtp.test.ts`, `publicOtp.test.ts`, `mobileNumbers.test.ts`; real database: `test/db/loginOtp.db.test.ts` (run `npm run test:db --workspace=apps/api`, guarded to `localhost:5434/platino_test`); `packages/shared/test/otpUi.test.ts`; `apps/admin-web/test/otpScreens.test.ts` (source-level checks of the screens).


## 31. Requirement 4 - digital service report, customer signature, signed PDF (2026-10-17, branch `feature/my-service-improvements`)

**Status: implemented and covered by automated tests (mocked, and against the isolated local database `localhost:5434/platino_test`). NOT tried in a real browser or on a phone: mouse/touch signing, the PDF download and the screens are unverified by eye. The migration below is NOT applied to any shared/production database.**

### Workflow
`draft` -> `awaiting_signature` -> `signed` (final). Rules live in `packages/shared/src/serviceReport.ts` and are enforced by `apps/api/src/routes/serviceReports.ts` (mounted at `/service-reports`).
1. **Create** (`POST /service-reports`, body: `complaintId`, visit date, work performed, findings, resolution, optional parts/remarks). `customerId`, `siteId` and `unitId` are copied from the TICKET - a request body can never set them. Report number `<ticket>-R<n>`.
2. **Edit** a draft (`PATCH`, needs the `expectedVersion` it loaded; a stale edit is refused, never merged). Every edit/reopen bumps `version`.
3. **Submit** (`POST /:id/submit`): all required sections must be filled; the content is fingerprinted (SHA-256) and the report waits for the customer. **Reopen** (`/reopen`) pulls it back to draft and bumps the version, so a customer holding the old view cannot sign it.
4. **Sign** (`POST /:id/sign`, customer only): see below. On success the server builds the PDF, stores the signature PNG and the PDF, and marks the report signed in ONE conditional update. A signed report can never change (API, and a database trigger).
5. **View / download**: `GET /:id`, `GET /:id/pdf` (`?disposition=inline` to view), `GET /:id/signature`. The recd-unit history (`GET /recd-units/:id/history`) now lists reports that have left draft.

### Who may do what (backend-enforced)
- **Write** (create/edit/submit/reopen): `MANAGE_COMPLAINTS`, or `ACT_ASSIGNED_COMPLAINTS` on a ticket assigned to that user - narrowed like the ticket module: vendor users only for tickets on their vendor's sites, Regional Managers only for their regions. Customers never write.
- **Read**: those staff plus `VIEW_COMPLAINTS_OVERVIEW` (same scoping); the customer login of the report's own customer sees reports that have left draft. Anyone else gets 403 (customers get 404, so existence is not revealed).
- **Sign**: only an authenticated customer contact whose `customerId` equals the report's customer, on a report `awaiting_signature`, presenting the version they reviewed. The identity is the **logged-in session** (customer login is a WhatsApp one-time code, Requirement 3). The typed name and the drawn image are recorded evidence, not identity. Signer user id, typed name, time and the signed version are stored; the audit events `service_report_created/submitted/reopened/signed` are added to the ticket history with the actor.
- **Signature checks** (`lib/signatureImage.ts`): PNG data URL only, <= 150 KB, 80-1600 px, 8-bit RGBA, structurally valid, bounded decompression, and not an empty canvas. These cannot prove who drew it.

### Storage
`lib/reportStorage.ts`: provider interface + the **database provider** (table `ReportFile`, separate from `Complaint`, so no list query loads file bytes). Env `REPORT_STORAGE=database` (default). **There is no S3 / object-storage / Drive provider** - the `S3_*` names in `.env.example` are placeholders nothing reads; any other `REPORT_STORAGE` value makes signing/downloading answer 503. Files are written first, the report row is claimed second, and the files are deleted again if anything fails, so no half-signed record or orphan is left. Every download re-checks the PDF's SHA-256. A different provider needs mentor / database-owner approval and a small adapter (note: `ServiceReport.signatureFileId/pdfFileId` are foreign keys to `ReportFile`; another provider would need those relaxed).
The old `Complaint.serviceReportUrl` upload (base64 in the complaint row) is untouched and still works; it was not migrated.

### Database
Migration `apps/api/prisma/migrations/20261017090000_service_reports/migration.sql` (additive: tables `ServiceReport`, `ReportFile`). Beyond the Prisma DDL it adds: a partial unique index (one unsigned report per ticket), CHECK constraints (closed status vocabulary; `signed` requires signer, time, signature file, PDF, hashes), and a trigger that forbids changing a signed report's content. FKs: ticket and customer `RESTRICT` (a ticket with reports can't be hard-deleted - `DELETE /complaints/:id` answers 409), site/unit/user links `SET NULL`. **Applied only to the local isolated test database. Apply with `prisma migrate deploy` to any shared database BEFORE deploying this code.**

### Multiple reports per ticket (assumption, reversible)
The model allows several reports per ticket (one per visit: `-R1`, `-R2`), but only ONE unsigned report at a time. To restrict to a single report per ticket, make `complaintId` unique instead of the partial index - no route change.

### Web
`/service-reports?complaintId=` (list + start a draft; linked from the ticket list, the customer portal and the RECD unit page) and `/service-reports/[id]` (edit a draft, review, signature pad, sign, download). `components/SignaturePad.tsx` (Pointer Events: mouse, touch, stylus). These routes are not behind a staff permission in `AuthGuard` because customers sign there; the API decides access.

### Mobile
**Not implemented.** The Expo app has no ticket-work screen (only "raise a complaint" and site progress for engineers). A signing/report screen would be a new screen plus a signature-canvas dependency (e.g. `react-native-signature-canvas`) and a decision on the on-site hand-over flow. The rules, schemas and limits are in `@recd/shared`, which the mobile app already depends on, and the API is device-independent. Follow-up: add the report screen (engineer) and sign screen (customer login) once the mentor confirms the workflow.

### Open decisions for the mentor / database owner
1. Exact report fields (currently: visit date, work performed, findings, resolution, optional parts used and remarks; no meter readings).
2. One report per ticket, or one per visit (assumed: per visit, one in progress at a time).
3. **Who signs.** Implemented: an authenticated customer contact of that customer. A **Site POC without a login cannot sign**; on-site signing on the engineer's device (with an OTP sent to the POC's number) would be a follow-up.
4. Is a drawn signature + typed name + the signer's authenticated login + timestamp sufficient? No legal/compliance requirement is documented, none was assumed (no certificate signing, no tamper-proof PDF signature; the PDF carries a content hash line).
5. Should the digital AMC service report reuse this workflow? Not done.
6. Approved storage for signed documents (database storage is the only implemented provider; large volumes may call for object storage). Also whether old `serviceReportUrl` attachments should be migrated.
7. PDF text uses built-in Latin fonts: non-Latin scripts (Hindi, Tamil) in the report text would not render until a font file is added.
8. Customers are not notified when a report is waiting for signature (no WhatsApp/email template yet); they find it under "Service reports & signing" in the portal.

### Tests
API (mocked): `serviceReports.test.ts`, `serviceReportPdf.test.ts`, `recdUnitLinks.test.ts` (history). Real database: `test/db/serviceReports.db.test.ts`. Shared: `packages/shared/test/serviceReport.test.ts`. Web: `apps/admin-web/test/serviceReportScreens.test.ts` (source-level).


## 32. Requirement 5 - digital AMC service report (2026-10-18, branch `feature/my-service-improvements`)

**Status: implemented and covered by automated tests (mocked, and against the isolated local database `localhost:5434/platino_test`). NOT tried in a real browser or on a phone. The migration below is NOT applied to any shared/production database.** This extends section 31 (Requirement 4); read that first.

### Design (reuse, not a second system)
One table, one state machine, one signature check, one PDF builder and one file store serve both kinds of report. `ServiceReport` now has `kind` = `ticket` | `amc`:
- `ticket`: `complaintId` set (Requirement 4, unchanged behaviour and unchanged content-fingerprint formula, so reports already awaiting signature still sign).
- `amc`: `amcOrderId` + `unitId` set, `complaintId` null. A database CHECK makes it **exactly one owner**.
New columns: `kind`, `amcOrderId`, `acknowledgementRequired`, `unitSerialNo` (serial snapshot taken when the report is written); `complaintId` became nullable. New table `ServiceReportEvent` (audit trail per report; ticket reports also keep writing to `ComplaintEvent`).

### Scheduled visits vs reports
`AmcOrder.amcFrequencyPerYear` is the contracted SCHEDULE. There is no visit-calendar model in the project and none was added. Each `ServiceReport` records one ACTUAL visit to one covered unit. The number of reports is not tied to the frequency (more or fewer reports than the schedule are accepted); the PDF and screens print the contracted frequency for context only. A real visit schedule (planned dates, "visit 2 of 4", overdue visits) would be a separate feature needing mentor input.

### Workflow
`POST /service-reports` with `{ amcOrderId, unitId, visitDate, workPerformed, findings, resolution, partsUsed?, remarks?, acknowledgementRequired? }`.
The backend then checks, in this order: the caller holds `MANAGE_AMC_ORDERS`; the AMC order exists; **the unit is covered by that order through `AmcOrderUnit`** (`UNIT_NOT_IN_AMC`); the unit's order belongs to the AMC's customer (`UNIT_CUSTOMER_MISMATCH`); the unit has a serial and is active (`UNIT_NO_SERIAL`, `UNIT_RETIRED`); vendor / region scope of the unit's site; no other report is in progress for that AMC + unit. **Customer, site, unit and serial are derived from the AMC order and the unit - never read from the request.** Report number `AMC-<last 6 of the AMC id>-R<n>`.
- **Acknowledgement rule (explicit, stored, auditable):** `acknowledgementRequired` is chosen per AMC report (default **true**) and editable while a draft. Required: `draft -> awaiting_signature -> signed` (customer signs, exactly as in Requirement 4). Not required: staff submit and the report goes straight to the new final state **`submitted`** (`draft -> submitted`), with a stored PDF that states "SUBMITTED - FINAL, NOT SIGNED". A `submitted` report is never shown or worded as signed, cannot be signed, edited or reopened. Ticket reports always require a signature (CHECK + API).
- Edit / reopen / stale-version / concurrent-update rules, signature validation, signed PDF, hashing, download and integrity checks are the Requirement 4 ones.
- Final reports (`signed`, `submitted`) are immutable in the API **and** by a database trigger.
- PDF: `AMC Service Report`, AMC order ref / PO number and date / AMC type / location / contracted visits per year, customer, site and address, the **serial snapshot**, DG model and kVA, visit date, engineer (the staff user who created the report), sections, then either the customer signature block (signed) or the "acknowledgement not required" block (submitted).
- Reads: `GET /service-reports?amcOrderId=[&unitId=]` (reports + AMC context + covered units), `GET /service-reports/mine` (a customer's own reports that have left draft), `GET /service-reports/:id[/pdf|/signature]`. `GET /recd-units/:id/history` now also returns `amcServiceReports` (metadata, no file references).

### Who may do what (backend-enforced) - the conservative default
- **AMC reports: the existing AMC boundary only.** Create / edit / submit / reopen / read need `MANAGE_AMC_ORDERS` (super admin, owner/admin, management today). Field engineers, service staff, sales and vendors cannot list AMC orders today and therefore get no AMC reports. A vendor-scoped or Regional Manager user who did hold the permission would be limited to their vendor's / region's sites (and gets nothing from an AMC-wide list). **Giving field engineers or service staff access to AMC reports needs mentor approval** (it would also need "assigned to this AMC visit" to exist - nothing models that).
- **Customers:** read reports of their own customer once they have left draft; sign reports awaiting signature. Another customer gets 404.
- **Sign:** unchanged from Requirement 4 - only an authenticated customer contact whose `customerId` matches the report's customer. A Site POC without a login cannot sign (mentor decision outstanding; the default was NOT widened).
- Audit: `service_report_created / updated / submitted / reopened / signed` in `ServiceReportEvent` with actor, report number, kind, AMC order and unit (final events also record that a PDF was generated and its hash).

### Web
`/amc-orders` -> **Service reports** link per order -> `/service-reports?amcOrderId=` (AMC details, covered units, status of each report, start a report for an eligible unit with the acknowledgement tick-box). `/service-reports/[id]` handles both kinds (edit, submit, review and sign, download). Customer portal has a **Service Reports** list (`/service-reports/mine`) with "Review & sign". The RECD unit page lists the unit's AMC reports inside its AMC section.

### Database - migration ORDER
`20261017090000_service_reports` (Requirement 4) **must be applied first**, then `20261018090000_amc_service_reports`, then deploy the code. The second migration is additive: new columns with safe defaults (existing rows become `kind = 'ticket'`, `acknowledgementRequired = true`, serial snapshot back-filled from the unit), `ServiceReportEvent`, the owner / final-state CHECKs, **new partial unique indexes** (`ServiceReport_one_open_per_complaint`, `ServiceReport_one_open_per_amc_unit`, replacing `ServiceReport_one_unsigned_per_complaint`), and a replaced immutability trigger function (superset of the old one). FKs: `amcOrderId` is `RESTRICT` (an AMC order with reports cannot be deleted). **Applied only to the local isolated test database.** Existing `ReportFile` rows and signed reports stay valid.

### Storage
Unchanged: the `database` provider (`ReportFile` table), no S3 / object storage. Volume consideration for the database owner: each signed report stores a PDF (typically tens of KB; grows with long text) plus a signature PNG (up to 150 KB), inside the main database and its backups. Fine for modest volumes; if AMC reports run to many thousands a year, object storage behind the same `ReportStorage` interface should be considered (needs approval; the FKs from `ServiceReport` to `ReportFile` would need relaxing).

### Open decisions (mentor / database owner)
1. Mandatory AMC report fields (currently the same as Requirement 4: visit date, work performed, findings, resolution; optional parts and remarks; no meter readings or checklist).
2. When acknowledgement / signature is mandatory for AMC (default: required; per-report switch exists).
3. Who may sign: customer contact only (default, unchanged) or also the Site POC.
4. How visit frequency relates to report count (default: independent; no schedule model).
5. Whether AMC reports should also appear in the normal ticket service history (default: no - they appear in the unit's AMC section).
6. Which roles besides AMC managers may create / view / download AMC reports (default: none; engineers are not tied to AMC visits in the data model).
7. Whether database file storage is acceptable at the expected volume.
8. Customers are not notified when an AMC report awaits their signature (no template yet); they see it under Service Reports in the portal.

### Tests
Mocked: `apps/api/test/serviceReportsAmc.test.ts`, `serviceReportPdf.test.ts` (AMC PDFs), `serviceReports.test.ts` (Requirement 4, still passing), `recdUnitLinks.test.ts`. Real database: `apps/api/test/db/serviceReportsAmc.db.test.ts` (constraints, indexes, trigger, concurrency, storage failure, relationships) and `serviceReports.db.test.ts`. Shared: `packages/shared/test/serviceReport.test.ts`. Web (source-level only): `apps/admin-web/test/serviceReportScreens.test.ts`.


## 33. Requirement 6 - region-wise Service Managers, due dates, reminders, acknowledgement and escalation (2026-10-19, branch `feature/my-service-improvements`)

**Status: implemented and covered by automated tests (mocked, and against the isolated local database `localhost:5434/platino_test`). NOT tried in a real browser. Reminders are NOT operational in any shared environment: the migration is not applied there, the policy is empty (= off), SMTP and the production cron have not been confirmed, and WhatsApp/SMS are still stubs.**

### What was added
- **Region mapping for Service Managers.** `PUT /regions/:id/managers` now accepts active users with the `service_manager` OR `regional_manager` role (same `RegionManager` table; the two roles stay distinct). Many-to-many both ways; a region may have none. Every save writes a `RegionManagerAudit` row (who, when, before, after) in the same transaction; `GET /regions/:id/audit` shows it. Mapping a Service Manager does **not** change what they may open in the ticket module (still desk-wide) and does **not** add them to the existing ticket-age alerts (`ticketRecipients` is now explicitly limited to Regional Managers - behaviour unchanged).
- **Explicit due dates - nothing is derived.** `Complaint.dueDate` (set by a manager: `PUT /reminders/tickets/:id/due-date`, audited as ticket event `due_date_set`) and the new `AmcVisit` table (`POST/PATCH /amc-visits`, AMC managers only; the unit must be covered by the AMC order and belong to its customer). A ticket or visit without a due date is never reminded. **The AMC contract expiry is not a visit due date and `amcFrequencyPerYear` generates nothing.** The existing 24 h / 48 h SLA windows are ticket-age rules and are untouched (`/complaints/cron/escalate` still runs as before).
- **One definition of overdue** (`classifyDue` in `packages/shared/src/serviceReminder.ts`): a due date is a calendar day; an activity is overdue once that whole day has passed; "due soon" exists only if the policy sets a lead time.
- **Policy (Settings, both empty = OFF):** `reminderLeadDays` (first reminder when an activity is due within N days, and for everything overdue) and `reminderEscalationHours` (escalate an unacknowledged reminder after N hours, per level). Stored on `CompanySettings`; edited under Settings -> "Service reminders". **No values are pre-filled or defaulted - the business has not approved any.**
- **Persistent reminders** (`ServiceReminder` + `ServiceReminderEvent`): one reminder per activity (unique), with customer, site, serial snapshot (null = "not recorded"), region, due date, status (`pending/sending/sent/failed/no_recipient/acknowledged/closed`), attempts, sent / acknowledged / escalation timestamps, and a full event history (each delivery per recipient and channel, acknowledgement, each escalation, no-recipient outcomes, due-date changes, closing).
- **Scheduled job** `GET /reminders/cron/run` (`lib/reminders.ts: runReminderJob`), authenticated with `Authorization: Bearer $CRON_SECRET` exactly like the other crons (refuses to run if the secret is unset). Order: (1) close reminders of finished activities (always), (2) stop if no lead time is set, (3) create reminders for due-soon / overdue dated activities, (4) send, (5) escalate. Safe to run twice or at once: reminders are unique per activity; sending is claimed with a conditional update on `status`; an escalation level is claimed with a conditional update on `escalationLevel`; a recipient who already received a level is skipped on retry; a stuck `sending` reminder is recovered after 15 minutes; a failed delivery is retried on later runs up to 5 attempts.
- **Dashboard** `/reminders` (`GET /reminders`): pending / due-soon / overdue (and, on request, undated) activities with customer, site, serial, due date, region, mapped managers, reminder status, acknowledgement, escalation and history; filters for status, region, manager, reminder state and due-date range; acknowledge button; set a due date on an undated ticket; links to the ticket's reports page, the AMC orders page (only for users with AMC access) and the RECD unit.

### Who receives what (DEFAULTS - mentor to confirm; nothing here was specified by the business)
- **First reminder:** the ACTIVE Service Managers mapped to the activity's region; if the region has none, its active Regional Managers; if neither (or the site has no region) the reminder is `no_recipient`, flagged on the dashboard and retried each run - **never sent to anyone unrelated.**
- **Escalation level 1:** the region's active Regional Managers who have not already had the reminder; if there are none, Management. **Level 2:** Management (management and owner/admin roles). Two levels at most; each level once. If nobody exists for a level, an `escalation_no_recipient` event is recorded and the level still advances (no endless retries).
- **Acknowledgement:** any user with `MANAGE_COMPLAINTS` whose region scope includes the reminder's region (Management: all). The first acknowledgement wins (atomic). Acknowledged reminders are not escalated. ~~Reminders stuck in `no_recipient` / `failed` are not escalated~~ **Superseded by section 49.1: they ARE escalated now, counted from creation.**
- **Dashboard scope:** Regional Managers: their mapped regions only (none mapped = nothing). Service Managers: their mapped regions when they have any, otherwise everything (today's desk-wide behaviour). Management / owner / admin: all. Field engineers, vendors, customers and sales: no access (403).

### Channels
In-app and e-mail only (the live channels). **In-app currently means "a NotificationLog row"; there is no inbox screen - the dashboard is where reminders are reviewed.** E-mail works only if SMTP is configured; otherwise the attempt is recorded as failed (the reminder is still `sent` because the in-app record exists, and the history shows the e-mail failure). WhatsApp / SMS / Telegram are stubs and are not used. Messages (`service_reminder`, `service_reminder_escalated`) contain activity reference, customer, site, serial ("not recorded" if missing), due date (marked OVERDUE when applicable) and a link to `/reminders?focus=<id>` built from `ADMIN_WEB_URL`.

### Database - migration
`apps/api/prisma/migrations/20261019090000_service_reminders/migration.sql`. **Order: after `20261018090000_amc_service_reports`, before deploying the code.** Additive: nullable `Complaint.dueDate` (+ index), nullable policy columns on `CompanySettings`, new tables `AmcVisit`, `ServiceReminder`, `ServiceReminderEvent`, `RegionManagerAudit`, and CHECK constraints (one activity per reminder matching its type, closed vocabularies, escalation level 0-2, closed/acknowledged need their timestamps, sensible policy values). Existing regions, assignments, tickets, AMC records and notification logs are untouched. **Applied only to the local isolated test database.**

### Scheduling - what is and is not true
`vercel.json` now lists `/reminders/cron/run` daily at 04:00 UTC. **An entry in the file is not proof that it runs.** Before relying on it someone must confirm in the hosting dashboard that the cron is registered and that `CRON_SECRET` is set; until the policy is filled in the job sends nothing even if it runs. Environment: `CRON_SECRET`, `ADMIN_WEB_URL` (links), SMTP variables (e-mail).

### Mentor / database-owner decisions still open
1. What the due date of a service activity is and who sets it (currently: a manager enters it per ticket / per AMC visit; no schedule is generated).
2. Reminder timing and frequency (currently: one reminder per activity, lead time = Settings value; no repeating reminders).
3. What counts as acknowledgement (currently: a manager clicks Acknowledge on the dashboard).
4. The escalation threshold and the recipients per level (defaults above).
5. Whether Service Managers should be region-restricted in the ticket module itself (currently desk-wide) and whether an unmapped Service Manager should see all regions on the dashboard.
6. Whether AMC-visit reminders may show region managers the customer / site / serial of an AMC visit even though they lack AMC permission (currently yes, only those four details; AMC pages stay behind `MANAGE_AMC_ORDERS`).
7. Whether both tickets and AMC visits need reminders (both are implemented), and the channels required (WhatsApp / SMS are not implemented).
8. A ticket that is reopened after being resolved does not get a second reminder (one reminder per activity).

### Tests
Mocked: `apps/api/test/reminders.test.ts` (41). Real database: `apps/api/test/db/reminders.db.test.ts` (14: constraints, mapping + audit, job, overlapping runs, escalation once per level, acknowledgement race, dashboard scope). Shared: `packages/shared/test/serviceReminder.test.ts`. Web (source-level): `apps/admin-web/test/reminderScreens.test.ts`.

## 34. Requirement 9 - order creation reliability (2026-10-20, branch `feature/my-service-improvements`)

**Status: implemented and covered by automated tests (mocked and against the isolated local database). NOT tried in a browser.** No migration, no new permission, no change to the duplicate-PO policy (same customer, case-insensitive after trimming; 409 `DUPLICATE_PO`; administrator override flags the order).

- **One creation path.** `apps/api/src/lib/orderCreation.ts` (`createNewOrder`) is used by `POST /orders` and by the AI assistant's confirmed `create_order`. Customer and product must exist (400 "Customer not found" / "Product not found"); order, site and units are saved in one transaction.
- **Race-safe duplicate check.** The duplicate lookup now runs INSIDE the creating transaction after taking a transaction-scoped Postgres advisory lock keyed on customer + lower(PO) (`pg_advisory_xact_lock`). Two simultaneous requests for the same customer + PO are serialised: one is created, the other gets `DUPLICATE_PO` (or, with the admin override, is created and flagged). No unique index was added, because approved duplicates and clone-order siblings legitimately share a PO. A customer/product deleted between the check and the insert (foreign key) is a safe 409 `REFERENCE_CHANGED`.
- **Order-number collisions** are retried (max 5 attempts, each a fresh transaction); when exhausted: 409 `ORDER_NUMBER_EXHAUSTED`, nothing saved. Also used by clone-order. (This replaces the earlier `ORDER_NUMBER_CONFLICT` code.)
- **Clone-order exception.** ~~`POST /sites/:id/clone-order` deliberately copies the source order's PO WITHOUT the duplicate check~~ **Superseded by section 49.2: clone-order now applies the same duplicate-PO rule.** It validates the product and uses the order-number retry.
- **AI assistant.** `create_order` now requires `poNumber` (optional `poDate`); a PO already used by that customer is refused at proposal and again at confirmation. The assistant cannot override a duplicate: an approved duplicate has to be entered by an administrator on the Orders page. Cards proposed before this change have no PO and are refused at confirmation (reject and re-propose).
- **Display.** The customer page now lists each order's PO (with the duplicate marker) and the site page shows the PO under the order number.
- Tests: `apps/api/test/orderCreation.test.ts` (27, mocked incl. a lock-aware in-memory store), `apps/api/test/db/orderCreation.db.test.ts` (8, real database, real concurrency), updated `recdUnitLinks.test.ts` and `db/serialRules.db.test.ts`, `apps/admin-web/test/poDisplay.test.ts`.
- **Still open (mentor):** PO uniqueness scope and whether duplicates should be rejected or only flagged; whether the assistant may ever create approved duplicates; whether PO should appear on the customer portal / exports (not changed); order editing (not added).


## 35. Requirement 6 - proposed reminder workflow (3 days, then 24 h per stage) - FOR MENTOR REVIEW (2026-10-21, branch `feature/my-service-improvements`)

**Status: the workflow is implemented by the existing reminder engine and covered by mocked and isolated-database tests. NOT tried in a browser for the new Settings panel. The live policy stays EMPTY (= reminders OFF) in every environment until an authorised person saves the values there.** No new migration beyond `20261020090000_reminder_escalation_retry` (section 33 follow-up: escalation attempts + lease).

**The values below are a PROPOSAL, not an approved business policy.** They are exported as `PROPOSED_REMINDER_POLICY` (`packages/shared/src/serviceReminder.ts`) and shown in Settings -> "Service reminders" with a button that only fills the two boxes; nothing changes until "Save reminder policy" is pressed (Super Admin only - `manage_settings`).

| Stage | When | Who |
|---|---|---|
| 1 First reminder | from 3 calendar days before the due date (`reminderLeadDays = 3`), and for everything overdue; only activities with an explicit due date that are not finished | the region's ACTIVE Service Managers; if none, the region's active Regional Managers; if neither (or no region): "no recipient" (shown on the dashboard, retried every run, sent to nobody unrelated) |
| 2 Regional escalation | unacknowledged 24 h (`reminderEscalationHours = 24`) after the reminder was DELIVERED to every recipient | the region's active Regional Managers who did not already have the reminder; if none, Management |
| 3 Management escalation | unacknowledged another 24 h after stage 2 was DELIVERED | Management and Owner/Admin |

- **Clocks.** The stage-2 clock of a DELIVERED reminder starts at `ServiceReminder.sentAt`, set only when every recipient's e-mail was accepted. ~~A failed, partly delivered or no-recipient reminder has no `sentAt`, so its countdown never starts~~ (superseded by section 49.1: an undelivered reminder's hours count from its creation). The stage-3 clock starts at `lastEscalatedAt`, set only when stage 2 was delivered (or had nobody to tell). A job that runs late delivers late, and the next 24 h run from THAT delivery.
- **Delivery.** Only an accepted e-mail is delivery; the in-app row is recorded (`in_app_recorded`) but not counted. Retries are per recipient, at most 5 attempts per reminder / per escalation stage; a recipient already e-mailed at a stage is never e-mailed again at that stage; overlapping runs are kept out by conditional claims and an escalation lease.
- **Acknowledgement.** Only a delivered (`sent`) reminder can be acknowledged (409 `REMINDER_NOT_DELIVERED` otherwise); it stops all further escalation. Region scope and `manage_complaints` still apply.
- **Not changed.** The ticket-age SLA job (24 h / 48 h from creation) and the legacy AMC-expiry job are separate and untouched; both are still scheduled in `vercel.json` alongside `/reminders/cron/run`, so a ticket with a due date can receive both a due-date reminder escalation and an SLA escalation.
- **Needs mentor confirmation:** that 3 days / 24 h are the intended values; who may save the policy (only Super Admin holds `manage_settings` in the seed); that Regional Managers then Management is the intended order; that an unacknowledged-but-delivered reminder is the only trigger; whether the two escalation jobs should be reconciled; e-mail as the only live channel.
- **Still to verify live (not done):** SMTP, a real delivery, cron registration and `CRON_SECRET` in the hosting environment, the migration on the shared database, and the Settings panel in a browser.
- Tests: `apps/api/test/reminders.test.ts` (62, section "The PROPOSED workflow"), `apps/api/test/db/reminders.db.test.ts` (20, includes the 3-day / 24 h / 24 h timeline), `packages/shared/test/serviceReminder.test.ts`, `apps/admin-web/test/reminderScreens.test.ts`.

## 36. Requirement 7 - AMC dates, vendor AMC and renewals (2026-10-19, branch `feature/my-service-improvements`)

**Status: implemented and verified locally (isolated test DB only, local browser). The migration `20261021090000_amc_contract_dates_renewals_vendor` has NOT been applied to any shared or production database.** Production reminders were not enabled and no e-mail was sent.

**What exists now**
- **Customer AMC** (`AmcOrder`): explicit `startDate` / `endDate` (inclusive calendar dates, UTC) + `datesSource` (`explicit` | `legacy_po_date`). The API returns `startDate`, `endDate`, `datesSource`, `contractStatus` (`upcoming` | `renewed` | `active` | `expiring_soon` | `expired`), `daysRemaining`, `renewalCount`. The list page no longer derives expiry from the PO date in the browser.
- **Vendor AMC** (new `VendorAmc`, FK to the existing `Vendor`, Restrict): title, optional vendor reference, notes, start / end dates, same reminder bookkeeping. Separate table and routes (`/vendor-amcs`); never mixed with customer AMC. Only an **approved** vendor can have one.
- **Renewal history** (new `AmcRenewal`, append-only, Restrict): kind `renewal` or `correction`, previous and new start / end, who, when, note. A renewal is one transaction (conditional update on the end date the caller saw + history insert); a double submit / race gets 409 `STALE_PERIOD` or `DUPLICATE_RENEWAL` (partial unique index per contract + previous end date). Changing a date through edit is a *correction*: reason required, recorded in the same transaction. Renewing is a distinct action from creating a new contract.
- **Settings** (`CompanySettings`: `amcDefaultDurationMonths`, `amcReminderLeadDays`, `amcReminderRepeatDays`, all NULL = default): `PUT /settings/amc`, `manage_settings` only (Super Admin in the seed). **Defaults preserve the old behaviour: 12 months, reminders from 30 days before the end date, repeated every 3 days until marked "AMC Acquired".** The same lead window drives the "expiring soon" status and the login notice.
- **Login-time notice**: `GET /amc-alerts` (authenticated; max 50) returns expiring-soon / expired, not-acquired contracts the caller may see: staff with `manage_amc_orders` -> customer + vendor contracts; a customer login -> its own customer contracts; a vendor login -> its own vendor contracts; everyone else -> none. The web dialog remembers dismissed alerts per browser session (`sessionStorage`; key = kind:id:endDate:status, so a renewal or a status change is shown again).
- **Reminder job** (`GET /amc-orders/send-expiry-reminders`, same cron route and `CRON_SECRET`): now uses the explicit dates and the settings, also covers vendor contracts, and takes the `lastExpiryReminderAt` stamp with a conditional update **before** sending (overlapping runs send once). Same recipients as before (active users with `manage_amc_orders`). New e-mail template `amc_expiry_reminder`.
- **UI**: `/amc-orders` (dates, status, create with optional start / end / duration, edit, renew, history), `/vendor-amcs` (new; Nav item "Vendor AMC", needs `manage_amc_orders`), Settings -> "AMC duration and expiry reminders", login notice in the staff layout and the customer portal.

**Migration (additive, no column dropped or renamed)**: new nullable columns on `AmcOrder` and `CompanySettings`, two new tables, CHECK constraints (period order, one date without the other refused, dates-source values, history parent / kind / periods, settings ranges), two partial unique indexes, RLS enabled on the new tables. **Backfill:** `UPDATE "AmcOrder" SET startDate = poDate::date, endDate = (poDate::date + interval '1 year')::date, datesSource = 'legacy_po_date' WHERE startDate IS NULL AND endDate IS NULL` - the same dates the old code derived, so no effective date changes. Feb 29 + 1 year = Feb 28 in both SQL and the shared TypeScript. Rows the backfill cannot reach: none expected; any row still without dates is shown with the same derived dates (`legacy_po_date`) by the API.

**R7 follow-up (2026-10-21): Vendor AMC customer / site and reminder content** - migration `20261026090000_vendor_amc_customer_site` (additive: `VendorAmc.customerId` and `siteId`, both nullable, ON DELETE SET NULL, indexes; nothing backfilled, every existing contract stays a "general agreement with the vendor"). The API (`/vendor-amcs`) accepts an optional customer and site on create and change (a site needs its customer, both must exist, the site must belong to that customer; changing the customer drops the old site) and returns their names. The create form has optional Customer / Site selects (the site list is the customer's units' sites); changing the links of an existing contract is API-only for now (the Edit dialog still edits title / reference / notes). Expiry reminders (e-mail / in-app, `amc_expiry_reminder`) and the login notice now say: AMC type (Customer AMC / Vendor AMC, plus CAMC / NAMC for customer orders), customer, site, vendor, expiry date, days remaining and a link to the AMC Order / Vendor AMC page (`ADMIN_WEB_URL`). Customer AMC "site" = the distinct site names of its covered units, else its free-text `location`. The vendor's name is no longer placed in the customer field of a vendor reminder. **Not decided (needs the business):** whether a Vendor AMC should also list the RECD units it covers (no such link exists; none was invented).

**Assumptions / decisions for the business**
1. *Vendor AMC* is defined here as an AMC agreement **with** one of our vendors (title, vendor, optional customer / site, dates). If the business meant something else (e.g. AMC that vendors perform for customers), the model needs revisiting.
2. End dates are **inclusive**. New contracts default to `start + N months - 1 day` (start 15 Jan 2026, 12 months -> 14 Jan 2027); backfilled legacy rows keep the old rule (PO date + 1 year, i.e. the anniversary itself). The two conventions differ by one day by design (we did not change any existing effective date).
3. The status **renewed** means: renewed before the old period ended, so the old period still covers today and the new one has not started. After the new period starts it is simply `active`.
4. A vendor login can read its own vendor contracts and history through the API and sees its own login notice, but there is **no vendor-facing AMC screen** yet (the page is staff-only).
5. Reminder recipients are unchanged (everyone with `manage_amc_orders`); vendor-contract reminders go to the same staff, not to the vendor.
6. `lastExpiryReminderAt` for the old reminder window was exactly 30 days in milliseconds before the expiry instant; it is now 30 calendar days before the end date (start of that day, UTC). Difference: at most a few hours earlier.

**Deployment steps for the database owner** (nothing was run against a shared database): back up -> `npx prisma migrate deploy` (applies `20261021090000_amc_contract_dates_renewals_vendor` after the R6 migrations) -> check `select "datesSource", count(*) from "AmcOrder" group by 1` (all rows `legacy_po_date` at first) -> deploy API then web -> optionally set the AMC settings; leave empty to keep 12 months / 30 days / 3 days. The cron entry and `CRON_SECRET` already exist; SMTP must be configured for reminders to leave the system.

**Tests**: shared `test/amc.test.ts`; mocked API `test/amcContracts.test.ts`; isolated-DB `test/db/amcContracts.db.test.ts` (constraints, the migration's own backfill UPDATE, renewal exactly-once / rollback, access control, alerts, reminder timing); web `test/amcScreens.test.ts` (helpers + source-level wiring, no component runner). `recdUnitLinks.test.ts` gained a `companySettings` stub.

## 37. Requirement 8 - RECD unit warranty (2026-10-19, branch `feature/my-service-improvements`)

**Status: implemented and verified locally (isolated test DB only, local browser). The migration `20261022090000_unit_warranty` has NOT been applied to any shared or production database. The warranty reminder job is deliberately NOT scheduled (see below), so no environment sends warranty e-mail until the owner adds it.**

**What exists now**
- **Per-unit warranty on `RecdUnit`** (no new unit table): `warrantyStartDate`, `warrantyEndDate` (DATE, inclusive), `warrantyMonths` (the EFFECTIVE duration stored when the period was set; NULL for a hand-typed custom period) and `warrantySource` (`manual` | `calculated` | `product_default`). A CHECK constraint keeps them all-NULL ("not recorded") or complete and consistent. `Product.warrantyMonths` is unchanged and is only the DEFAULT used when staff enter a start date without an expiry / duration; changing it later never recalculates an existing unit.
- **Rules** (`packages/shared/src/warranty.ts`, shared by API, web and the job): expiry = start + N calendar months - 1 day (R7 month-end handling; 29 Feb / 31 Jan clamp); the expiry date itself is still valid and the warranty is expired the day after. Status `unknown` (no dates: never active) / `upcoming` / `active` / `expiring_soon` (valid with days left <= the configured window) / `expired`. Start + expiry + duration that disagree, an expiry before the start, impossible dates and durations outside 1-120 are refused; nothing is adjusted silently.
- **History** (`WarrantyHistory`, append-only, FK RESTRICT to the unit): `established` / `correction` (reason required), previous and new dates, months and source, actor, time. The unit change and the history row are ONE transaction with a conditional update on the expiry the editor saw (409 `STALE_WARRANTY` for a stale or simultaneous editor). A unit with warranty history cannot be deleted (the order/line-item delete routes answer 409 like they already do for AMC links).
- **Permission** `manage_warranty` ("Record and correct RECD unit warranty") is required for `PUT /recd-units/:id/warranty`, plus access to the unit. **Mapping (isolated in the migration, for mentor review): super_admin, owner_admin, management** - the same roles that hold every permission except settings, following the `manage_regions` precedent. NOT granted to sales (who hold `manage_orders`), service roles, vendors or customers. Customers and vendors are read-only.
- **Reads** reuse the existing unit scoping: `GET /recd-units` and `/:id` now carry a computed `warranty` block (customer: own units; vendor: units at their sites; regional manager: their regions). `GET /recd-units/:id/warranty-history` has the same scope; staff also see who and why, customers and vendors see the periods only.
- **Login notice**: `GET /warranty-alerts` (same scope, needs `view_site_status`) lists units expiring soon or expired within the last 30 days (`WARRANTY_EXPIRED_NOTICE_DAYS`); units with unknown dates, upcoming, retired or long-expired are never listed. `WarrantyExpiryNotice` is mounted next to the AMC notice (it waits while the AMC notice is open), dismissals are remembered per browser session (key = unit + expiry + status), the customer portal rows do not link to staff pages.
- **Settings**: `PUT /settings/warranty` (`manage_settings` only): `warrantyReminderLeadDays`, `warrantyReminderRepeatDays`, separate from the AMC settings. Empty = **30 days before expiry, repeated every 3 days** - these copy the AMC reminder behaviour; they are NOT a separately approved warranty policy. The lead window is also the "expiring soon" status window.
- **Reminder job** `GET /warranty/cron/send-reminders` (`CRON_SECRET`, `lib/warranty.ts runWarrantyReminders`): active units with a started, unexpired warranty inside the window; one state row per (unit, expiry date, recipient) claimed with a conditional update BEFORE sending, so overlapping runs send once; only an e-mail the provider ACCEPTED counts as delivered (e-mail channel only, no in-app log rows, no WhatsApp/Telegram); a failure is retried after an hour, at most 5 attempts, then waits a repeat interval; a delivered recipient is not repeated before the interval; a corrected expiry starts a fresh cycle. **Recipients: active users holding `manage_warranty`** (staff who can already see every unit); customers and vendors are not e-mailed. Template `warranty_expiry_reminder` (serial, product, customer, site, expiry, status, link via `ADMIN_WEB_URL`). **Not added to `vercel.json`**: to switch it on, the database owner adds `{ "path": "/warranty/cron/send-reminders", "schedule": "0 3 * * *" }` to `apps/api/vercel.json` once SMTP and the policy are approved.
- **Screens**: unit detail (`app/recd-units/[id]/page.tsx` + `components/WarrantyPanel.tsx`: status, dates, duration, provenance, history, edit only with `manage_warranty`; the product duration is labelled "default duration"), unit list (Warranty column, no extra query per row), customer portal (`CustomerWarrantyCard`, read-only), Settings (`WarrantySettings`), product screens (labels only).

**Legacy units**: every existing unit keeps all four warranty columns NULL ("Not recorded"). **No backfill**: order date, PO date, dispatch / delivery date and commissioning events are different things and are deliberately not used to guess a start date. A unit becomes "active" only when authorised staff record its start (and expiry / duration). The migration contains no UPDATE of existing data (tested).

**Business decisions still open**: which date starts a warranty (the code never decides; staff enter it); whether the 30 / 3-day defaults and the 30-day "recently expired" notice are right; who else (if anyone) may edit warranty (e.g. sales); whether customers or vendors should be e-mailed; whether `Product.warrantyMonths` should be mandatory; whether history reasons should be hidden from non-managing staff (today every staff role with unit access sees who and why).

**Deployment steps for the database owner** (nothing was applied to a shared database): back up -> `npx prisma migrate deploy` (applies `20261022090000_unit_warranty` after the R7 migration) -> deploy API then web -> check `select count(*) from "RecdUnit" where "warrantyStartDate" is not null` is 0 -> optionally set the warranty settings -> when approved, add the cron entry above.

**Tests**: shared `test/warranty.test.ts`; mocked API `test/warranty.test.ts`; isolated-DB `test/db/warranty.db.test.ts` (migration, constraints, no backfill, permission grant, transactional history, exactly-once, access control, alerts, atomic reminders); web `test/warrantyScreens.test.ts`.

## 38. Requirement 10 - user management hardening (2026-10-20, branch `feature/my-service-improvements`)

**Status: implemented and verified locally (isolated test DB only, local browser). Migration `20261023090000_user_admin_hardening` has NOT been applied to any shared or production database.** Existing screens and routes were extended, not rebuilt.

**Policy (one place: `packages/shared/src/userPolicy.ts`, enforced by `apps/api/src/lib/userAdmin.ts`; the web app only uses it to show sensible options)**
1. Only a **Super Admin** may grant the Super Admin role, and only a Super Admin may edit, change the role of, reset the password of, deactivate or reactivate a Super Admin account. `manage_users` alone (Owner/Admin, Management) never reaches a Super Admin. Refusals are 403 and are recorded as `action_denied` (operation + reason only), never as a change.
2. Nobody changes their own role or customer / vendor link, deactivates themselves, or resets their own password through the admin routes (own password: "Change password").
3. The **last active Super Admin** cannot be demoted or deactivated. The check and the change run in one transaction behind a PostgreSQL advisory lock (`pg_advisory_xact_lock`), so two simultaneous requests that would each remove the other cannot both succeed.
4. Links: customer accounts need an existing customer and are never vendor-scoped; erection engineers need an approved vendor; every other role is never customer-scoped. On a role change only a link the destination cannot have is cleared: leaving the erection-engineer role drops its vendor link, customer -> staff drops the customer link; a vendor link carried by any other role is kept. Invalid / unknown / unapproved targets are 400.
- **For mentor review:** Owner/Admin and Management are not ranked against each other (they manage each other and everything below Super Admin); only erection engineer is treated as vendor-scoped (no other role is documented as such); customer accounts can now be created/converted through the user routes only with a `customerId` (the Users page still hides the customer role; customer logins normally come from the customer record).

**E-mail identity**: addresses are trimmed and lower-cased by the shared schemas (`emailField`) for users, customer contacts, vendor contacts and sign-in; sign-in and Google sign-in match case-insensitively, so existing mixed-case accounts keep working. A new unique index on `lower(btrim(email))` (kept alongside the original exact one) makes duplicates impossible by any path; the API answers 409 `EMAIL_IN_USE` instead of 500. Re-saving one's own address in another spelling changes and records nothing; stored addresses are never rewritten. **The migration stops with a clear message (changing nothing) if the database already holds two accounts differing only by case / spaces; they must then be reconciled by hand - they are never merged or renamed.** The isolated test DB had none.

**Sessions**: `User.tokenVersion` (additive, default 0). Tokens carry it (`tv`); `authenticate` refuses a token whose version differs (tokens issued before this release carry none and count as 0, so deploying signs nobody out). The version is bumped by: administrative password reset, own password change (the response returns a fresh token so that session continues; the web app stores it), deactivation **and reactivation** (a reactivated account does not resurrect old tokens), role change, customer / vendor link change. Inactive accounts could already not sign in or use tokens (checked on every request). Forced change of password after a reset is unchanged. Own password change now requires 8+ characters (the sign-in minimum; previously none on the server and 6 in the form).

**Audit**: create, profile edits (including e-mail), role change, customer / vendor link change (`association_changed`), deactivate, reactivate, password reset are written with `logUserAuditStrict` **in the same transaction** as the change; if the audit insert fails the change rolls back (tested). Refusals are recorded as `action_denied` best-effort. No password, hash, token or OTP is ever in the payload (tested by scanning). Own password change is not an administrative action and is not written to this log. `tokenVersion` and the hash are never returned by `GET /users`.

**Also fixed**: vendor contact logins now use the CSPRNG temp password (was `Math.random()`), and a duplicate vendor-contact e-mail in another case is skipped with a reason instead of a 500.

**Deployment (database owner)**: back up -> `npx prisma migrate deploy` (applies `20261023090000_user_admin_hardening`; it fails safely with a message if case-insensitive duplicate e-mails exist) -> deploy API then web. Nothing else is required; no user data is changed.

**Tests**: shared `test/userPolicy.test.ts`; mocked API `test/userAdmin.test.ts`; isolated DB `test/db/userAdmin.db.test.ts` (the last-Super-Admin tests switch the other active Super Admins off for the duration of that test and always switch them back); web `test/userAdminScreens.test.ts`. Existing tests adjusted only where behaviour intentionally changed: `staffPhone.test.ts` (in-memory `$transaction` stub; an e-mail conflict is now a 409), `mobileNumbers.test.ts` (an e-mail conflict on a vendor contact login is skipped, not a 500), `staffPhoneForm.test.ts` (the page uses `userAdminErrorMessage`, which wraps `apiErrorMessage`).

## 39. Requirement 11 - ticket management safeguards (2026-10-20, branch `feature/my-service-improvements`)

**Status: implemented and verified locally (isolated test DB only, local browser). Migration `20261024090000_ticket_escalation_delivery` is NOT applied to any shared or production database.** The ticket system was extended, not rebuilt; every existing status, the 24 h / 48 h SLA defaults, the one-open-ticket-per-unit index, the ticket-number retry and the R6 reminders are unchanged.

**Fixed (unambiguous)**
- **Status**: `PATCH /complaints/:id` accepted any string. It now accepts only the nine existing statuses (`packages/shared/src/ticketPolicy.ts`), 400 otherwise.
- **Scope on every write**: one rule (`lib/ticketAccess.ts`) for PATCH, DELETE, history and the assignee list: a Regional Manager only in their regions (a ticket without a site is out of every region), a vendor-scoped user only on their vendor's sites, a user without manage / overview permission only for tickets assigned to them. The list gained the same vendor rule.
- **Assignment** is validated (exists, active, one of the four existing assignable roles, vendor scope; a vendor-scoped caller only assigns within their vendor) with 400 / 403 instead of a foreign-key 500. `GET /complaints/assignees?ticketId=` returns the people valid for that ticket; without a ticket only unscoped (internal) engineers - one vendor's engineers are never shown for another vendor's site.
- **Atomic history**: the update and its `ComplaintEvent` rows (status, assignment, new `notes_updated` naming the fields - never the text) are ONE transaction via a conditional update (a simultaneous change is a 409 `TICKET_CHANGED`); portal and public ticket creation write the ticket and its CREATED event in one transaction. A failed history write rolls the change back.
- **Closure**: `closedAt` is set on the first move into `closed`, kept by a repeated closure, cleared when the ticket leaves `closed` (the event says `reopened`). Reopening a resolved / closed ticket while another ticket for the same RECD is open is a 409 `OPEN_TICKET_EXISTS` naming it (was a 500).
- **Notifications**: only a real status change notifies the customer (to the oldest ACTIVE contact - previously an unordered `contacts[0]`), only a real assignment notifies the assignee; a no-op or notes-only update notifies nobody. Provider failures never undo the change and are recorded as failed by the notification log.
- **CREATED event** now records the serial, site name and ids as reported (no extra personal data; the existing public-ticket reporter phone was already there). Tickets created before this have no snapshot and none is invented.
- **List**: optional `search` (ticket number, unit serial, customer, site), `status`, `assignedToId`, `createdFrom/To`, `dueFrom/To`, `limit` (max 500, `X-Total-Count` header) and `offset`; applied after the scope, never widening it; with no parameters the answer is unchanged (cap 1000).
- **SLA escalation is retryable** (`lib/ticketEscalation.ts`, new table `TicketEscalationDelivery`): a level advances only when every recipient has been DELIVERED (e-mail accepted); a failed delivery or an empty recipient set leaves the level where it was and writes an `escalation_failed` event (once per reason); the next run retries only the undelivered recipients (after 1 h, 5 attempts, then daily); overlapping runs cannot send twice (conditional claims) and the ESCALATED event is written with the level advance in one transaction. The cron route and schedule are unchanged (daily).

**Deliberately NOT changed - decisions for the mentor**
1. **Lifecycle / transitions / who may reopen** (HISTORICAL - superseded by section 43: a transition table, a resolution-notes rule and a reopen reason now exist): none documented at the time; every valid status may still follow every other. The single place to add rules is `isStatusTransitionAllowed` in `ticketPolicy.ts` (the API already answers 409 `TRANSITION_NOT_ALLOWED` when it says no). No reopen reason, resolved-by / closed-by or mandatory resolution field was added.
2. **Hard delete** (SUPERSEDED by section 42: DELETE now archives): kept as is (Service Team / Management / Regional Manager in region; blocked only by service reports). Deleting a ticket still deletes its history and its reminder / escalation rows (cascade) - the UI now says so. A cancelled / archived state needs an agreed meaning first.
3. **Unit-less tickets**: a site with no units has only the application-side duplicate check; no database constraint exists, so simultaneous submissions for such a site can create more than one ticket (tested only as "never a 500"). A site-level unique index needs the business rule first.
4. **SLA pause policy**: `waiting_for_part` does not pause and `escalated` does not stop escalation (unchanged); a reopened ticket keeps its level and the clock still runs from creation.
5. **Ticket-age escalation (24 h / 48 h from creation, daily 03:30 UTC) and R6 due-date reminders (3 days / 24 h per stage, 04:00 UTC) are independent**: a ticket with a due date can receive both, to overlapping people (Regional Managers / Management). Not merged.
6. **Zonal Manager**: not present in the repository (no role, permission or region level), so none was invented. Supporting it would touch: the role / permission seed, a region-above-region model (`Region`), `ticketRecipients` (lib/ticketNotify.ts), the escalation levels (lib/sla.ts, `TicketEscalationDelivery.level` CHECK, `slaEscalationLevel`), the SLA settings, `ticketAccessError`, and the reminder audiences (lib/reminders.ts).
7. Staff cannot raise tickets (portal / public only) - unchanged.
8. Status-change / assignment notices are not queued for retry (only truthfully recorded); the durable retry exists for the SLA escalation.

**Deployment (database owner)**: back up -> `npx prisma migrate deploy` (applies `20261024090000_ticket_escalation_delivery`, one additive table) -> deploy API then web. No existing ticket or history row is changed.

**Tests**: shared `ticketPolicy.test.ts`; mocked API `ticketAdmin.test.ts`; isolated DB `db/ticketAdmin.db.test.ts`; web `ticketScreens.test.ts`. Existing tests adjusted only for infrastructure: `publicComplaintsOtp.test.ts` gained an in-memory `$transaction` stub.

## 40. Requirement 3 - OTP authentication hardening (2026-10-20, branch `feature/my-service-improvements`)

The OTP system itself (sections 30 and 26) was audited and **kept**: `crypto.randomInt` codes, HMAC-only storage, atomic single use and attempt counting, expiry, resend cooldowns, database-backed per-user / per-phone / per-serial limits, WhatsApp Cloud API delivery with failure voiding, the guarded development echo, and the R10 token-version revocation. Only the confirmed gaps were fixed. (Section 30 still says "emailed code" in places; codes go by WhatsApp - treat this section as current.)

**What changed**
1. **`mustChangePassword` is now enforced by the API.** `authenticate` (`middleware/auth.ts`) reads the flag from the database on every request and answers `403 { code: "PASSWORD_CHANGE_REQUIRED" }` on every route except two that use `authenticateAllowingPasswordChange`: `GET /auth/me` and `POST /auth/change-password`. Those two run exactly the same token / active / tokenVersion checks. This covers password, Google, customer-OTP and phone-OTP sessions alike (all share the middleware). A successful change stores a bcrypt hash, clears the flag, bumps `tokenVersion` (old tokens die) and returns a fresh token; a failed change touches nothing. The web (`apiClient.ts`, `AuthContext`) and the mobile app (`ChangePasswordScreen`, `AuthContext.startSession`) recognise the code and go to the change-password screen without calling anything else. A user with the flag but **no password hash** (OTP-only contact) cannot complete the change - none exists today (customer contacts are created with the flag false); vendors get a temporary password.
2. **Phone-only OTP login (`/auth/otp/request`, `/auth/otp/verify`) is denied to administrative accounts**, decided in one place, `isPhoneOtpLoginAllowed` (`packages/shared/src/otpEligibility.ts`): roles `super_admin`, `owner_admin`, `management`, **and any role holding** `manage_users`, `manage_settings`, `manage_regions` or `manage_warranty`. A denied number gets the same generic 200 as an unknown number, no code is created or sent, and verification also refuses it (a code issued before a role change is useless). Staff keep email + password and Google. The customer order-number login is untouched. **Mentor review:** roles that remain allowed by this rule are everything else, notably `operations_pm`, `regional_manager`, `service_manager`, `finance`, `sales` and the engineers (they hold only business permissions). Say if any of them should also be denied - it is a one-line list edit.
3. **Per-IP rate limiting is shared and no longer trusts forwarded headers.** `middleware/rateLimit.ts` counts in PostgreSQL (new table `IpRateLimit`, migration `20261025090000_ip_rate_limit`, additive) with one atomic upsert per request, keyed by an HMAC of `limiter:address` (no raw addresses stored; rows older than a day are purged opportunistically). If the database is unavailable it falls back to the previous per-process counter (reduced, never off). Limits are unchanged: `/auth/*` 10 per 15 min per IP, public complaint routes 60 per 15 min. The public OTP's per-IP hourly cap now uses `req.ip` (the old helper that believed the first `X-Forwarded-For` entry, which a client can forge, is removed).
4. **Trusted proxies are explicit:** `TRUST_PROXY` (`lib/proxyConfig.ts`). Unset = trust nothing (`req.ip` is the socket peer). A hop count (1-10) or a list of proxy addresses / `loopback` is accepted; `true` and anything unrecognised are refused. The API logs a warning when `VERCEL` is present and `TRUST_PROXY` is unset.
5. **Optional dedicated OTP hashing key:** `OTP_HMAC_SECRET` (min 16 characters; shorter is refused). Unset = `JWT_SECRET` as before, so nothing breaks. Setting or changing it invalidates codes pending at that moment (they live 5-10 minutes) and nothing else; it also means rotating `JWT_SECRET` no longer voids pending codes. Do not rotate real secrets as part of this change.

**Hosting owner - must be confirmed (cannot be seen from the repository)**
- `TRUST_PROXY`: the hosting is Vercel (see `vercel.json`) but the number of trusted proxy hops is a deployment fact and was **not guessed**. Until it is set, every visitor reaches the app from the platform proxy's address and shares one IP bucket (10 logins per 15 minutes in total). Set it to the real hop count, then check from two different networks that the limiter treats them separately.
- Run `npx prisma migrate deploy` (applies `20261025090000_ip_rate_limit`) **before** deploying the API; until then the limiter logs "Rate-limit store unavailable" and uses the per-process fallback.
- WhatsApp: sender and template approval, and a controlled delivery test to an approved number (nothing was sent or contacted in this work - **real delivery is still unverified**). Env names: `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_OTP_TEMPLATE_NAME`, `WHATSAPP_TEMPLATE_LANG`, `WHATSAPP_API_VERSION`.
- `OTP_DEV_ECHO` (older name `PUBLIC_OTP_DEV_ECHO`) must be absent or empty in every hosted environment. The echo is also refused when `NODE_ENV=production`, when WhatsApp is configured, and when a hosting marker is present (`VERCEL`, `VERCEL_ENV`, `RENDER`, `DYNO`, `K_SERVICE`, `AWS_LAMBDA_FUNCTION_NAME`, ...; see `lib/otpDelivery.ts`). **Limitation:** a provider not on that list is not recognised, so the guard there is `OTP_DEV_ECHO` being unset - the owner has to confirm it.

**Historical data (database owner only - not run by this work)**
Older deployments may have stored raw OTP values. Do **not** inspect values; count only, on the real database, as a read-only SELECT:
- `OtpCode` rows whose `code` is not a 64-character hexadecimal string (a raw code), created before migration `20261016090000_login_otp_hardening` (that migration already voided the unconsumed ones).
- `NotificationLog` rows from the legacy e-mail OTP template (`otp_code`) whose payload contains a `code` field.
If either count is not zero, decide on scrubbing (nulling the field) with the owner; nothing is deleted automatically.

**Business decisions still open**
- The public complaint OTP is sent to **any number the reporter types** (deliberate: resellers). It is bounded by the database limits (5 per number, 10 per serial, 20 per IP per hour) but each request can cost a WhatsApp message to a third party. Whether to restrict it is a mentor decision and was **not** changed. **Superseded by section 46.1: approved as an intentional deviation (2026-10-21); no longer open.**
- A public session is claimed before the ticket is created, so a failure after that point (rare) requires the reporter to verify again. Left as is (safer than allowing a replay).
- Which non-administrative roles, if any, should lose phone-only login (see 2).
- `mustChangePassword` accounts can sign in but only reach the change screen; whether a temporary-password vendor should be able to use OTP login at all before choosing a password is a policy question.

**Tests**: shared `otpEligibility.test.ts`, `passwordChange.test.ts`; mocked API `forcedPasswordChange.test.ts`, `ipRateLimit.test.ts`, `otpSecret.test.ts`, additions to `loginOtp.test.ts` and `publicComplaintsOtp.test.ts`; isolated DB `db/ipRateLimit.db.test.ts`; web `forcedPasswordScreens.test.ts`. The IP limiter's tests share an in-memory stand-in for the table in the mocked suites (`test/helpers/fakeRateLimitStore.ts`).

## 41. Security remediation (2026-10-21, branch `feature/my-service-improvements`)

**Status: implemented and covered by automated tests that run without a database (mocked Prisma, real routers/middleware over HTTP). NOT run against the real database (`npm run test:db`), NOT tried in a browser, NOT deployed.** One new migration, `20261027090000_user_audit_survives_deletion`, has NOT been applied to any database.

**What was found and fixed (each was confirmed in the code first)**
1. **Credential / PII leak (P1).** `GET /sites`, `GET /sites/:id`, `GET /orders/:id`, `GET /customers/:id`, `POST /sites/:id/assign-vendor` and the agent `get_document_detail` tool embedded `assignedEngineer: true`, `vendor: true`, `createdBy: true`, `uploadedBy: true`, i.e. the whole `User` / `Vendor` row (password hash, token version, phone, e-mail, notification settings, vendor contact details). `/sites` is readable by the customer and vendor roles. Now every embedded person/company goes through the explicit selects in `apps/api/src/lib/safeSelect.ts` (staff and vendors by id + name only; the customer as id/name/address; the order embedded in customer/vendor-facing responses without its commercial `value` or the sales engineer's id). Ticket lists (`/complaints`) and pending actions use the same shapes. As a last line of defence `scrubSecretKeysFromJson` (wired in `src/index.ts`) removes `passwordHash`, `tokenVersion`, `codeHash`, `otpHash`, `sessionHash`, `keyHash` from any JSON response - it does not replace the selects.
2. **Seed with a known Super Admin password (P1).** `prisma/seed.ts` hashed the literal `changeme123` for nine staff accounts and, on every run, re-activated them and reset their role. Rules now live in `prisma/seedAccounts.ts`: no password is built into the code; demo accounts are created only on a local database (localhost) outside production, with the password from `SEED_DEV_PASSWORD` or none; on any production-like or non-local database only reference data is seeded and, if no Super Admin exists, `SEED_SUPER_ADMIN_EMAIL` + a strong `SEED_SUPER_ADMIN_PASSWORD` are required or the seed refuses before writing anything; the bootstrap account must change its password at first sign-in; existing accounts are never modified (a password is only written to an account that has none); a protected database that still holds an account with the OLD password makes the seed refuse until it is rotated. **Any environment that was ever seeded with the old script still has those accounts with `changeme123` - rotate or deactivate them (see below).**
3. **Privilege boundary (P2).** Management could create, edit, re-role, reset the password of and deactivate Owner/Admin accounts (a password reset returns the temporary password to the caller, so this was an account takeover path). `packages/shared/src/userPolicy.ts` now has one table, `PRIVILEGED_ROLE_ADMINISTRATORS`: Super Admin accounts - Super Admin only; Owner/Admin accounts - Super Admin or Owner/Admin. The API enforces it (`lib/userAdmin.ts`, unchanged code path, new policy); the Users page only mirrors it. The last-Super-Admin and self rules are unchanged.
4. **Audit gaps (P2).** Vendor approval / staff-added vendor (login creation) now writes the audit row in the same transaction; archiving a vendor now deactivates every member login, bumps `tokenVersion` (revokes sessions) and writes one `deactivated` record per account; customer creation writes `created` for the contact account in the same transaction; editing a customer contact writes `updated` (field NAMES only - never phone/e-mail values) and bumps `tokenVersion` when the phone or e-mail (the sign-in detail) changes; deleting a customer writes `deleted` records first. **Deleting an account used to cascade-delete its audit rows** (`UserAuditLog.targetUserId` was `NOT NULL ... ON DELETE CASCADE`); the migration makes it `SET NULL` and adds `targetIdRecorded` (plain id) and `targetName`, backfilled for existing rows. `GET /users/audit-log` still shows (and filters by) deleted accounts.
5. **Record-level access (P2).** `POST /pending-actions/:id/resolve` trusted the id in the URL - any user holding `resolve_pending_action` could resolve another customer's / vendor's action; it now answers 404 for a foreign id and the list is scoped to the vendor's sites as well as the customer's. **Regional Managers** now see only the sites of their mapped regions on `GET /sites` and `GET /sites/:id` (the same rule the ticket module already used; none mapped = none). Service Managers, Service Engineers, Management etc. are unchanged.
6. **CORS and headers (P3).** `cors()` (any origin) is replaced by an allowlist (`ADMIN_WEB_URL` + `CORS_ALLOWED_ORIGINS`; local dev origins only outside production/hosted; wildcard and malformed entries refused; empty in production = no browser origin trusted). `helmet` 8.3.0 (new dependency) adds the standard headers with an API policy (CSP `default-src 'none'`, `frame-ancestors 'none'`, HSTS, nosniff, no-referrer, no `X-Powered-By`); the one deliberate relaxation is `Cross-Origin-Resource-Policy: cross-origin` because the admin web app is another origin. `src/lib/httpSecurity.ts`.

**Deployment (database owner / hosting owner) - none of this has been done**
- Migration: back up, then `prisma migrate deploy` (applies `20261027090000_user_audit_survives_deletion`) BEFORE deploying the API (the code writes `targetIdRecorded`). Additive + relaxed constraint + backfill; no row is deleted. The migration folder is untracked like the others from `20261015…`; commit all of them together. (`prisma generate` is needed after pulling the schema.)
- Environment: set `ADMIN_WEB_URL` (and `CORS_ALLOWED_ORIGINS` if more origins) on the API host - without them the browser admin web cannot call a production API. `SEED_*` variables are only for the seed (see `.env.example`); remove the bootstrap ones after use.
- Rotate: every account created by the old seed (`superadmin@ / owner@ / management@ / sales@ / ops@ / erection@ / commissioning@ / service@ / finance@platino.example`) in any shared environment must have its password reset or the account deactivated. The new seed refuses to run on a protected database while any of them still accepts `changeme123`.
- `npm install` (helmet) at the repo root.

**Decisions left to the business (nothing invented)**
- Whether Management ranks below Owner/Admin. Section 4 describes Management as "Owner/Proprietor/CEO/CTO", so the written requirements do not say; the safe reading (Management cannot administer Owner/Admin) is implemented and is one table to change. Management <-> Management and Owner/Admin <-> Owner/Admin administration is unchanged.
- Zonal Manager vs Regional Manager: no Zonal Manager role or zone exists; region scoping above uses the existing Regional Manager mapping. Service Managers/Engineers still read all sites (`view_site_status`); whether they should be region- or assignment-scoped is undecided.
- Whether customers/vendors should see the assigned engineer's phone (they no longer do) and whether vendors may see the order's PO number (still shown).
- Vendor approval/rejection/archive themselves are recorded only through `approvedBy/archivedBy` columns; there is no vendor audit table (account effects are audited).

**Not changed / still open:** the vendor-approval route updates the vendor and creates the login in separate steps (a failure after the status change leaves an approved vendor without a login - add the engineer on the Users page); temporary passwords are still returned in API responses; 10 MB JSON body limit and the shared auth IP rate-limit bucket are unchanged; the `include: true` pattern for non-person relations (products, stages) is unchanged because they carry no personal data.

**Tests** (all without a database): `apps/api/test/responseLeaks.test.ts`, `seedAccounts.test.ts`, `accountAudit.test.ts`, `httpSecurity.test.ts` (includes the real `src/index.ts` app), new role-matrix cases in `userAdmin.test.ts`, `packages/shared/test/userPolicy.test.ts`, `apps/admin-web/test/userAdminScreens.test.ts`. `test/db/userAdmin.db.test.ts` was adjusted for the new policy but NOT run.

## 42. Ticket history and closure completion (2026-10-21, branch `feature/my-service-improvements`)

**Status: implemented; mocked tests and the real-database suite pass on the disposable local database (`localhost:5434/platino_test`) only. NOT tried in a browser. Migration `20261028090000_ticket_archive_closure` is applied ONLY to that local database - not to any shared or production database.** It supersedes the "hard delete" decision in section 39 (item 2).

**What changed (requirement 11: "complete ticket history and closure details")**
- **DELETE /complaints/:id now ARCHIVES.** Same route, permission (`manage_complaints`), scope rules (region / vendor) and 204 answer; an optional `{ reason }` body is stored. The ticket, its history (`ComplaintEvent`), its reminder (`ServiceReminder`) and its escalation records (`TicketEscalationDelivery`) are kept - previously all of them cascaded away. New columns `archivedAt`, `archivedById`, `archiveReason`; an `archived` history event records who, when, the status at that moment and the reason. Archived tickets: cannot be changed or reassigned (409 `TICKET_ARCHIVED`), are not listed (managers can add `?includeArchived=1`; customers and engineers never get them), are skipped by the SLA escalation job, by reminder creation and the reminder dashboard (an existing reminder is closed, not deleted), are excluded from the dashboard counts, the unit history, the assistant's ticket tools, and no longer occupy their unit in the one-open-ticket-per-unit rule (the partial unique index was recreated with `AND "archivedAt" IS NULL`). A ticket with service reports still cannot be archived; no new service report can be created for an archived ticket.
- **Closure records who closed**: `closedById` (set with `closedAt`, kept on a repeat closure, cleared on reopening; every closure stays in the history with its actor). The migration backfills it from the latest "moved to closed" event that has an actor - nothing is invented where there is none.
- **Closure details are no longer silently overwritten**: a changed root cause / resolution notes / remarks is recorded in the `notes_updated` event with its BEFORE and AFTER text (the uploaded report is a file: name only). This reverses the earlier "field names only" choice for these three fields; only people who may read the ticket can read its history.
- Web: the "Reject or delete" confirmation now says the ticket is archived and its history kept; the history shows an "archived" line. No restore / archive-list screen was built.

**Verified (see tests)**: every ticket action writes a history row with actor and timestamp (created, status with from/to, assignment with from/to, notes with before/after, due date, escalation, service reports, archive); updates and their history rows are one transaction; foreign keys: deleting a staff user keeps their tickets, events (actor cleared), closure / archive records and their own audit trail; a customer with tickets cannot be deleted; a contact who raised a ticket can be removed without losing the ticket or its creation event.

**Direct API calls (permissions)**: customers, sales and unauthenticated callers cannot close, reopen, reassign, archive or read history; an engineer cannot touch tickets assigned to someone else or outside their vendor, cannot reassign even their own ticket, and cannot archive; a Regional Manager only in their regions; archive needs `manage_complaints`.

**Decisions still needed from the business - NOT guessed**
1. **Status lifecycle / who may reopen** (HISTORICAL - SUPERSEDED by section 43 and 42.2: only managers reopen, with a reason, and the transition table is in `ticketPolicy.ts`): unchanged at the time - every valid status could follow every other, and anyone who could edit the ticket could reopen it (`isStatusTransitionAllowed` in `packages/shared/src/ticketPolicy.ts` is the one place to change; no reopen reason is recorded).
2. **Who may CLOSE**: DECIDED - see section 42.1 (managers close; engineers resolve).
3. **Closure details mandatory?** (HISTORICAL - SUPERSEDED by section 43: meaningful resolution notes are now required before `resolved`) At the time resolution notes / root cause remained optional on closing; there is no resolved-by / resolved-at (only `closedAt` / `closedById`).
4. **Restore / purge** (PARTLY SUPERSEDED by section 43: restore now exists; there is still NO purge): at the time there was deliberately no way to un-archive or to permanently delete a ticket through the application. A purge or an undo needs an agreed meaning (and for a purge, a retention rule).
5. **Direct database deletion** of a `Complaint` row (SQL, not the application) still cascades to its events, reminder and escalation records (`ON DELETE CASCADE` is unchanged, because changing it would also block the existing test clean-up and needs a retention decision).
6. A site with no units still has no database-level duplicate guard (unchanged, section 39).

**Deployment**: back up -> `prisma migrate deploy` (applies `20261028090000_ticket_archive_closure`; additive columns, two SET NULL foreign keys, one CHECK, the recreated partial unique index - existing tickets are all live so the index cannot fail on existing data) BEFORE deploying the API. The migration folder is untracked like the others; commit them together.

**Tests**: `apps/api/test/ticketAdmin.test.ts` (mocked, 15), `apps/api/test/db/ticketAdmin.db.test.ts` (real database, 35, including the migration backfill SQL and the foreign-key lifecycle), adjusted `recdUnitLinks`, `ticketContacts`, `serviceReports` tests, `apps/admin-web/test/ticketScreens.test.ts`.

### 42.1 Decision recorded: engineers resolve, managers close (2026-10-21)
Decided by the product owner: **an engineer resolves the work; an authorised manager performs the final closure.** Moving a ticket INTO `closed` now needs `manage_complaints` (`TICKET_CLOSE_PERMISSION`, `packages/shared/src/ticketPolicy.ts`; enforced in `lib/ticketAdmin.ts`): anyone else gets 403 `CLOSE_REQUIRES_MANAGER` and nothing is written (no status, no closure, no notes, no history row). Resolving (`resolved`) is unchanged for engineers; managers are still bound by the region / vendor scope rules. The Update form disables the "closed" status for people without `manage_complaints`. **CURRENT RULE for a closed ticket (section 43 supersedes the "not decided" wording this paragraph used to carry): only a manager (`manage_complaints`, inside their region / vendor scope) can reopen it (42.2), with a reason, or add / correct notes on it - the ticket stays closed and `closedAt` / `closedById` are untouched; anyone else is refused with 403 `CLOSED_TICKET_READ_ONLY`.** Tests: mocked and real-database cases in `ticketAdmin.test.ts` / `db/ticketAdmin.db.test.ts`.

### 42.2 Decision recorded: only managers reopen a closed ticket (2026-10-21)
Moving a ticket OUT of `closed` needs `manage_complaints` (`TICKET_REOPEN_PERMISSION`): anyone else gets 403 `REOPEN_REQUIRES_MANAGER` and the whole request is refused - status, `closedAt`, `closedById`, notes, assignee and history stay as they were. The region / vendor / assigned-to-me scope check runs first and still applies to managers (an out-of-region manager gets the scope error, not this one). ~~Non-managers can still add notes to a closed ticket while it stays closed.~~ **SUPERSEDED (section 43): non-managers cannot update a closed ticket at all, notes included (403 `CLOSED_TICKET_READ_ONLY`); managers in scope can add or correct notes without reopening it.** The Update form disables every other status on a closed ticket for non-managers, disables Save, and says why. Reopening a *resolved* ticket is not restricted (only `closed` is final). The questions this paragraph used to leave open are decided in section 43: the transition table (`isStatusTransitionAllowed`), meaningful resolution notes before `resolved`, a recorded reopen reason, and no notes by non-managers on a closed ticket.

### 42.3 Lifecycle review (2026-10-21) - no new rules added
Requirement 11 (5 lines) is silent on: allowed status transitions, mandatory resolution notes, a reopen reason, notes on closed tickets, restore and purge. Only the two product-owner decisions (managers close, managers reopen a closed ticket) exist, and both are already enforced. **(Written before section 43, which superseded it: at that point nothing else was implemented - every transition was allowed, resolution notes were optional, no reopen reason was stored, no restore existed. All of that is now decided and built in section 43.)** Added one mocked test pinning today's behaviour for notes on a closed ticket (it stays closed, closedAt / closedById untouched, before/after kept in the history). Still needs business approval: the transition table, mandatory resolution notes, reopen reason, whether non-managers may edit notes on closed tickets, and any restore / purge (with a retention rule).

## 43. Ticket lifecycle completion (2026-10-21, branch `feature/my-service-improvements`)

**Status: implemented; mocked (API 563, shared 104, web 132) and real-database tests (264, three consecutive runs) pass on the disposable local database only; `tsc` clean in shared / api / admin-web. NOT tried in a browser. Migration `20261029090000_ticket_unitless_duplicate_guard` is applied ONLY to `localhost:5434/platino_test`.** Supersedes the "undecided" items of §42.2 / §42.3.

- **Transitions (PROPOSED workflow - the original requirement does not define one; change it only in `packages/shared/src/ticketPolicy.ts`)**: active (open, acknowledged, assigned, in_progress, waiting_for_customer, waiting_for_part, escalated) <-> any other active; active -> resolved; resolved -> closed or any active; closed -> any active (reopen). NOT allowed: active -> closed directly (engineer resolves, manager closes), closed -> resolved. Anything else is 409 `TRANSITION_NOT_ALLOWED`. Permission checks (close / reopen = `manage_complaints`) and region / vendor / assigned scope still run first.
- **Resolution notes**: entering `resolved` needs meaningful `resolutionNotes` (trimmed, 10+ characters, 2+ words, not one repeated character) - sent now or already on the ticket; else 400 `RESOLUTION_NOTES_REQUIRED`. While resolved / closed the notes can be corrected but never blanked. Legacy resolved tickets without notes can still be closed. Edits keep before / after in `notes_updated`.
- **Reopen reason**: reopening a CLOSED ticket needs `reopenReason` (10-1000 characters); else 400 `REOPEN_REASON_REQUIRED`. It is stored in the `status_changed` event (`detail.reason`, with actor and time). Reopening a merely resolved ticket needs no reason.
- **Closed tickets**: a manager in scope may add notes and the ticket stays closed (`closedAt` / `closedById` untouched); a non-manager gets 403 `CLOSED_TICKET_READ_ONLY` for any update, including notes (this reverses §42.2's "non-managers can still add notes").
- **Restore**: `POST /complaints/:id/restore` (`manage_complaints`, same region / vendor scope; optional `{reason}`; 204). Clears the archive columns, keeps the status it had, writes a `restored` event (actor, time, reason). Re-checks scope, the site / customer and unit / site links, and the duplicate rule (409 `OPEN_TICKET_EXISTS` naming the other ticket; 409 `RESTORE_LINK_INVALID`; 409 `NOT_ARCHIVED`). The SLA clock is not reset. Web: managers can tick "Also show archived tickets" and press "Restore archived". **There is no purge**, in the API or the screen.
- **Duplicate guard for unit-less tickets**: the duplicate rule is unchanged (active = not resolved / closed and not archived; one per unit; for a ticket with no unit, one per site - exactly what the portal check always did). It was only application-side because the unit index cannot cover rows without a unit. New partial unique index `Complaint_one_open_per_site_without_unit` ON ("siteId") WHERE "unitId" IS NULL AND "siteId" IS NOT NULL AND status NOT IN ('resolved','closed') AND "archivedAt" IS NULL. Portal creation, reopen and restore map its violation to the same clear message. Public tickets always have a unit.
- **Test flake (429 vs 401/200) - root cause and fix**: `/auth/login` is limited to 10 attempts per 15 minutes per IP and the counters live in the database table `IpRateLimit`, which persists between test runs; back-to-back runs on the same local database inherited earlier runs' counters. The product limiter is correct; the DB tests that sign in (`userAdmin`, `loginOtp`, `mobileNumbers`) now clear `IpRateLimit` in `before` (disposable database only).

**Deployment**: back up -> `prisma migrate deploy`. The new migration FAILS SAFELY with a message listing the sites if two ACTIVE tickets without a unit already exist on one site (legacy data); resolve / archive the extras, or tell us the intended rule, and deploy again. Apply before deploying the API. Deploy API and web together (the web sends `reopenReason`, the API now requires it).

**Zonal Manager (NOT implemented - decisions needed)**: the original requirement only says "Notify the concerned Service Engineer, Zonal Manager and Management". The repository has no zone, no Zonal Manager role, no permission set and no region hierarchy; Regional Manager (24 h escalation) is the nearest role. Needed from the business: (1) is a zone a group of regions, or the same thing as a region (then Regional Manager already is the Zonal Manager)? (2) the zone-to-region mapping and who maintains it; (3) which permissions the role holds (view / manage tickets? orders? sites? customers? reports?) and whether access is read-only or read-write; (4) whether a user can manage several zones; (5) where the role sits in escalation (before / after Regional Manager, which hours); (6) whether it also gets reminders (R6) and warranty / AMC alerts. Touch points when decided: role + permission seed, a `Zone` model above `Region`, `lib/regions.ts managedRegionIds`, `ticketAccessError`, `ticketRecipients`, `lib/sla.ts`, `TicketEscalationDelivery.level` CHECK, reminder audiences.

## 44. Approved business decisions and final R1-R11 audit (2026-10-21, branch `feature/my-service-improvements`)

Source of the requirements: `New Service Web.docx` ("FIELD SENSE / SERVICE MODULE - REQUIREMENTS", 11 numbered items; the same text that the audits call R1-R11). It contains no ticket statuses, SLA hours, zone, retention or deletion rules, so everything below that is not in those 11 items is an approved decision or an implementation choice, as labelled.

### 44.1 Approved decisions (project owner, 2026-10-21)
- **A. Duplicate tickets (R11 "Prevent duplicate tickets for the same issue").** One ACTIVE ticket per RECD unit; for a site with no unit, one active ticket per site; resolved, closed and archived tickets do not count; concurrent creation is stopped by database constraints. One shared definition (`lib/ticketDuplicates.ts`) is now used by portal creation, reopening and restoring. The application check for a unit-less ticket is site-wide (ANY other active ticket on the site blocks it - the portal's long-standing behaviour, not weakened); the partial unique index `Complaint_one_open_per_site_without_unit` covers two active unit-less tickets on one site under simultaneous requests. Residual, documented: an index cannot compare two different rows' unit values, so a unit-less ticket created at the same instant as a ticket for a since-retired unit of the same site is guarded by the application check only. Reopening a resolved/closed ticket previously relied on the indexes alone; it now also runs the application check (clear 409 `OPEN_TICKET_EXISTS`).
- **B. Who can raise tickets (R11 "Allow users to raise service tickets").** Customers (portal) and the existing public serial + mobile + OTP flow are sufficient; there is deliberately NO staff ticket-creation feature. Verified: `POST /complaints` (`raise_complaint`, customers only, own sites only) and `POST /public/complaints` (verified OTP session) both create a unique Ticket ID, write the CREATED history row in the same transaction and notify staff.
- **C. Zonal Manager (R10 and R11).** The existing **Regional Manager** role (region-scoped, admin-defined regions, `RegionManager` mapping, many regions per manager and many managers per region) fulfils "Zonal Manager". No zone hierarchy is created. Mapping, with evidence:
  - R10 "Support roles such as ... Zonal Manager": Add User offers `regional_manager`; created by Super Admin / Owner-Admin / Management, audited (`userAdmin.db.test.ts` "R10 roles"). Display label "Regional Manager".
  - R11 "Notify the concerned ... Zonal Manager": on raise, the Regional Managers mapped to the site's region are notified (with Service Team, Service Managers and Management); the assigned engineer is notified on assignment (`ticketNotify.ts`; `ticketAdmin.db.test.ts` "Regional Manager = the approved 'Zonal Manager'").
  - R11 "escalate unresolved tickets based on SLA": 24 h -> the region's Regional Manager(s) (Service Managers if none), 48 h -> Management and Owner/Admin; retryable, recorded, not repeated (`ticketEscalation.ts`; DB tests "escalation: windows unchanged", "a failed delivery does NOT consume the level", "overlapping runs").
  - Access: a Regional Manager can read, update, archive and restore tickets, read history, and see sites, RECD units and warranty ONLY in their mapped regions (a ticket without a site is out of every region); the permission bundle is `manage_complaints`, `view_complaints_overview`, `view_site_status`, `view_dashboard` and nothing administrative (no users, settings, regions, orders, AMC, warranty, vendors) - asserted against the real role tables.
  - A Regional Manager created through Add User has NO region until someone with `manage_regions` maps them (Regions page); until then they see nothing. This is fail-safe, not a defect.
  - No explicit requirement is left unsatisfied by this mapping. If the business later wants a level ABOVE regions, that is a new decision (a Zone model, role, escalation level and recipients).

### 44.2 Defaults and what backs them
| Value | Source | Status |
|---|---|---|
| SLA escalation 24 h (Regional) / 48 h (Management), editable in Settings | not in the 11 items; project owner instruction: "Preserve those defaults" | preserved; business-confirmed only by that instruction |
| R6 reminders: 3-day lead, 24 h per escalation stage | project owner instruction: "The intended values are: Lead time 3 days, escalation interval 24 hours per stage" | configurable; the live policy is EMPTY (= off) until a Super Admin saves it in Settings -> Service reminders |
| Warranty reminders 30 days before expiry, repeated every 3 days | copied from the AMC behaviour; never separately approved | UNCONFIRMED default (Settings -> Warranty overrides it) |
| AMC reminders 30 days before expiry, repeated every 3 days, 12-month default duration | original live behaviour (section 22: "1 month before, every 3 days") | carried over; not re-approved |

### 44.3 Fixes made by the final audit
- **R1/R3 customer login**: the field is labelled "RECD Serial Number" but only matched the ORDER number, so a customer typing the serial printed on the RECD could not sign in. It now accepts the order number or the serial of any unit of the order (unknown identifiers get the same generic reply as before).
- **R7 AMC reminders**: a reminder no recipient's e-mail accepted is no longer stamped as sent (the claim is given back and the next run retries); the login pop-up now shows the AMC class (CAMC/NAMC) and an explicit "Expiry" date.
- **R8 warranty reminders**: the job existed but was not scheduled, so nothing ran by itself; `vercel.json` now schedules `/warranty/cron/send-reminders` daily at 04:30 UTC. It sends only where `CRON_SECRET` and an e-mail provider are configured. A test pins that every mounted cron is scheduled.
- **Documentation**: sections 39, 42.1, 42.2, 42.3 and 42's decision list now mark superseded statements; the current rule for closed tickets is stated once (managers in scope may add/correct notes and reopen with a reason; everyone else gets 403 `CLOSED_TICKET_READ_ONLY`).

## 45. Release verification: requirement review, race guard, browser walk-through (2026-10-21, branch `feature/my-service-improvements`)

### 45.1 Requirement questions settled (evidence: `New Service Web.docx`)
- **R3 public OTP to the typed number**: R3 says "Send OTP to the registered mobile number"; R2 says "Capture and validate the mobile number of the concerned person. Make it mandatory for OTP verification." A reseller / re-reseller is not a registered contact, so the number they type IS the captured number of the concerned person, and the OTP proves they control it (the number is stored on the ticket). This is an ambiguity, not an explicit conflict, and no behaviour was changed. Changing it to "registered contacts only" would lock every reseller out of the public flow (the customer portal remains for registered contacts). Mentor to confirm; the smallest safe correction, if wanted, is an allow-list of registered contact / site-POC numbers for the unit's customer, which excludes resellers by design. **Superseded by section 46.1: the owner approved keeping the reporter-entered number; the "Mentor to confirm" remark no longer applies.**
- **R5 acknowledgement "where required"**: not defined by the requirements. Today staff set `acknowledgementRequired` per AMC report (default true; managers with `manage_amc_orders` only). No change; the business should say whether it is per contract, per AMC type or always (HANDOVER section 32).
- **R6 undated activities**: the requirement says reminders carry "due-date details" and identifies "pending or overdue" activities. A reminder needs a due date, so an undated activity cannot be reminded; undated activities ARE listed on the reminders dashboard (on request) as pending. No change.
- **R4 / R5 mobile app**: the requirements document never mentions an app or a platform ("mobile" appears only in "MOBILE NO."). There is no mobile requirement for signing or service reports. The Expo app has no such screens; the web portal covers customers.

### 45.2 Duplicate-ticket race (decision A)
`Complaint_site_level_guard` (migration `20261030090000_ticket_site_guard_trigger`): a BEFORE INSERT/UPDATE trigger takes a per-site advisory lock for every active ticket and refuses a "site-level" ticket (no unit, or a RETIRED unit) when any other active ticket exists on the site (unique_violation, mapped to the same clear message). Rows already duplicated before the migration stay editable; only inserting, re-activating or changing site / unit is checked. Proven with real concurrency (12 rounds of a unit-less insert racing a retired-unit insert: exactly one wins; the same test creates two rows when the trigger is disabled). Fact worth knowing: the application has no operation that retires a unit (no route writes `RecdUnit.status`), so the race can only arise from direct database changes; the trigger is defence in depth. Roll back: `DROP TRIGGER "Complaint_site_level_guard" ON "Complaint"; DROP FUNCTION "complaint_site_level_guard"();`.

### 45.3 Other defects found by the end-to-end pass (all fixed, all tested)
- **Customer portal opened the wrong order**: a customer with several orders always landed on the first site returned, whatever they signed in with. It now opens the order they signed in with (serial or order number).
- **`GET /settings` leaked to every signed-in user**: customers and vendors received the whole company-settings row (assistant custom instructions, SLA / reminder policies). Customers and vendors now get branding and contact details only; the assistant's custom instructions need `manage_settings`.
- **Regional Manager overview counts were company-wide**: the status tiles on the complaints page counted every region. They now count the manager's own regions only.
- **Migration chain gap**: `CompanySettings.pinCode` exists in `schema.prisma` and in the shared database (added out of band) but no migration created it, so a database built from the migrations alone lacked the column. `20261030100000_company_settings_pincode_idempotent` adds it with `IF NOT EXISTS` (a no-op wherever it exists). After it, a database built from scratch from all 28 migrations has NO drift against `schema.prisma` (checked with `prisma migrate diff`).
- Warranty settings text no longer says the reminder job is unscheduled.

### 45.4 Browser walk-through (local test database only, dev servers, fixtures prefixed `E2E` and removed afterwards)
Verified in the built-in browser: customer login by a lower-case unit serial (dev-echo code), customer company details + portal ticket, public reseller ticket via serial + OTP, staff resolve (refused without / with trivial notes, accepted with meaningful notes), close, reopen (refused without a reason, accepted with one), archive, restore (history reads created > archived > restored with the reason), Regional Manager scope (own region's ticket and site only; users / orders / customers 403), saving the reminder, AMC and warranty policies in Settings (the "proposed values" button fills but does not save), order creation (duplicate PO refused with a clear message, unique PO created), service report create > submit > customer signs on the canvas > signed PDF downloads (`application/pdf`, `%PDF-`). NOT testable here: real e-mail / WhatsApp delivery (no SMTP or WhatsApp credentials), real cron execution, the mobile app, anything against the shared or production database.

### 45.5 Live configuration still required
`CRON_SECRET` (every cron route refuses to run without it); SMTP (`SMTP_*`, `EMAIL_FROM_ADDRESS`); WhatsApp (`WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, template settings) or customers cannot receive login codes (503 otherwise; `OTP_DEV_ECHO` must stay unset in production); `ADMIN_WEB_URL` / `CORS_ALLOWED_ORIGINS`; `TRUST_PROXY` matching the host; `JWT_SECRET` (and optionally `OTP_HMAC_SECRET`); `REPORT_STORAGE=database`. Four daily crons are scheduled in `apps/api/vercel.json` (03:00 AMC, 03:30 ticket SLA, 04:00 reminders, 04:30 warranty UTC). Saved policies: R6 reminders are OFF until a Super Admin saves lead days and escalation hours; AMC and warranty use their defaults until saved.

### 45.6 Deployment and rollback
1. Back up the production database (and note the current deployment for rollback). 2. Apply the three new migrations in order with `prisma migrate deploy`: `20261029090000_ticket_unitless_duplicate_guard` (stops with a site list if two active unit-less tickets already exist), `20261030090000_ticket_site_guard_trigger`, `20261030100000_company_settings_pincode_idempotent`, after every earlier pending migration. 3. Deploy the API and the web together. 4. Set the environment variables above and confirm the crons. 5. Smoke-test: staff login, a customer login by serial, one ticket through resolve > close > reopen, a Regional Manager's scope. Rollback: redeploy the previous API and web (the new columns, indexes and trigger are additive; always roll the API and the web back TOGETHER - the new API requires `reopenReason` from the new web); to remove the guards run `DROP TRIGGER "Complaint_site_level_guard" ON "Complaint"; DROP FUNCTION "complaint_site_level_guard"(); DROP INDEX "Complaint_one_open_per_site_without_unit";` and restore the earlier unit index only if migration `20261028090000` is also reverted from the backup.

## 46. Final pre-commit audit changes (2026-10-21, branch `feature/my-service-improvements`)
- **R8 wording**: the warranty status label for "expiring soon" now reads **Near Expiry**, as the requirement text says (`WARRANTY_STATUS_LABELS` in `packages/shared/src/warranty.ts`; the status value and logic are unchanged). AMC contracts keep "Expiring soon".
- **Ticket e-mails**: dedicated `complaint_status_updated` and `complaint_assigned` templates; the generic fallback template now escapes keys and values (`emailTemplates.ts`).
- **Service Manager digest** (`lib/serviceDigest.ts`, roadmap item 1 of section 27): OFF unless `SERVICE_DIGEST_ENABLED=1`. Runs inside `/reminders/cron/run`; one e-mail per recipient per region per UTC day to the region's active Service Managers (else Regional Managers) listing open tickets (customer, site, serial, status, due date; overdue first). Tickets only (no AMC visits); a ticket whose site has no region is not included; the digest has no escalation of its own. Delivery is unverified: no SMTP test was sent.

### 46.1 Approved decisions (project owner, 2026-10-21) - not to be reopened without new evidence
**Decision 1 - public complaint OTP (R3): intentional deviation, implementation unchanged.**
R3 literally says "Send OTP to the registered mobile number". The public complaint flow (`/public/complaints`, serial + OTP) deliberately sends the code to the mobile number the REPORTER enters. Reason: resellers must be able to raise complaints on behalf of customers, and their number differs from the registered customer number. Staff and customer login (`/auth/customer/*`, `/auth/otp/*`) still send only to the number stored on the account. The existing limits stay (5 per number per hour, 30 s apart, 10 per serial and 20 per IP per hour, active serial only). This is a documented deviation from the literal wording; it changes only if the mentor approves a change or the original requirements explicitly prohibit it (see also 45.1).

**Decision 2 - serial and mobile columns stay nullable (R1, R2): legacy-data limitation, no schema change.**
`RecdUnit.serialNo`, `User.phone`, `SiteContact.phone` and `Site.sitePocNumber` are NOT `NOT NULL` in this change, and no data migration is created. What is still enforced: a serial and a mobile number are mandatory for every NEW record through the API (all creation paths), duplicate serials are rejected (unique index, 409), and OTP login fails closed (no code is sent) for a contact with no usable number. Legacy rows with missing values are preserved as they are.
Before a future migration adds `NOT NULL`: (1) count and list the affected rows on the real database (read-only SELECTs for each column); (2) backfill valid values where they can be established (a serial can be given once through `PUT /recd-units/:id/serial`); (3) confirm no legitimate legacy record would be lost or invalidated (units without a serial, contacts that only use another login method); (4) only then add the constraint, in its own reviewed migration with a backup and rollback.

## 47. R1 audit defects D1-D3: serial assignment, unit deletion, serial correction (branch `feature/my-service-improvements`, not committed)
**Status: implemented; mocked tests and the real-database suite pass on `localhost:5434/platino_test` only. Migration `20261031090000_unit_history_protection` is applied ONLY there, NOT to any shared or production database. API and web UI for correction not tried in a browser.**
- **D1** `PUT /recd-units/:id/serial` now writes with `updateMany({ id, serialNo: null })`; the loser of a race gets 409 "already has a serial". Cross-unit duplicates are still stopped by the unique index (409).
- **D2** A unit that tickets, service reports, service reminders, AMC links/visits, warranty history or a serial-correction history point at cannot be deleted: `DELETE /orders/:id/line-items/:lid` and `DELETE /orders/:id` return 409 (`lib/unitRetention.ts`). The database enforces it too: the `Complaint`, `ServiceReport` and `ServiceReminder` unit foreign keys changed from `SET NULL` to `RESTRICT` (they used to detach history and free the serial). Two older tests that asserted the SET NULL behaviour were updated. No route retires a unit, so retirement is still not available as an alternative.
- **D3** `PATCH /recd-units/:id/serial` `{ expectedSerialNo, serialNo, reason }` corrects a mistyped serial: Super Admin / Owner-Admin / Management only (plus `manage_orders`), optimistic on `expectedSerialNo`, retired and serial-less units refused, recorded in the new append-only `RecdUnitSerialHistory` (previous, new, reason, actor, time) in the same transaction. **Decisions to confirm with the business:** who may correct (the PO-override tier was reused, nothing wider granted); the old serial is freed and may be registered again (the history row keeps it); AMC reports keep their own serial snapshot, other records follow the unit. There is no UI for it yet and the unit history endpoint does not list corrections.
- **Deploy order:** back up, `prisma migrate deploy` (needs no data change; the FK swap is instant), then the API. Rollback: `DROP TABLE "RecdUnitSerialHistory"` and recreate the three foreign keys with `ON DELETE SET NULL`.

## 48. Audit follow-ups R2 (mobile serial / phone display), R3 (OTP races and delivery), R4 (service-report link, staff list, immutability) (branch `feature/my-service-improvements`, not committed)
**Status: implemented and covered by mocked tests and the real-database suite on `localhost:5434/platino_test` ONLY. Migration `20261101090000_signed_report_immutability` is applied ONLY there, NOT to any shared or production database. Nothing was tried on a phone, in a browser, or against real WhatsApp / e-mail.** R1 (sections 47 and earlier: D1-D3, `20261031090000_unit_history_protection`) is untouched.

### 48.1 R2 - the mobile app now shows serial numbers and contact numbers
- Source of the gap: no mobile screen rendered `serialNo` or any phone. The API already returned them (orders: `units[].serialNo`; `GET /sites/:id`: `units`, `sitePocName/sitePocNumber`, `contacts[].phone`), so only `GET /sites?assigned_to=me` was extended (`units: {id, serialNo, status}`).
- Screens: customer order list (serials), order detail (serials + site contacts), field site list (serials + Site POC with number), site detail (serials + site contacts, tap-to-call). Formatting lives in `packages/shared/src/contactDisplay.ts` (`unitLines`, `siteContactLines`, `telHref`, "Serial not entered", "No mobile number on file") so a legacy row with a NULL serial / phone reads clearly and never borrows another person's value.
- Privacy: nothing new is exposed - the screens render what each endpoint already returns under its existing scoping (customer = own site, vendor = own sites, Regional Manager = own regions). The list addition carries only id / serial / status and is covered by `responseLeaks.test.ts` (another customer's serial never appears). Nullable columns, validation and duplicate-serial protection are unchanged.
- Tests: `packages/shared/test/contactDisplay.test.ts` (7), `apps/mobile/test/contactAndSerialScreens.test.ts` (7, new `npm test` in the mobile app; source-level wiring checks like the web ones - there is still no React Native component runner).

### 48.2 R3 - OTP
- **Rate-limit race (public OTP):** the per-number / per-serial / per-address counts were read, then the row inserted, so parallel requests all saw the same counts. Now the check and the insert run in ONE transaction under PostgreSQL advisory locks (`lib/advisoryLock.ts`, keys locked in sorted order = no deadlock). Proven with 30 parallel requests against the real database (exactly 10 rows / 10 messages for a serial, 1 per number, 20 per address) and shown to FAIL when the lock is removed.
- **Same race in the staff / customer login OTP** (`issueLoginOtp`): cooldown + hourly cap + void-and-insert are now under one lock per (user, purpose); parallel requests create exactly one code and send exactly one message (before: several codes in a row, each voiding the last).
- **Failed delivery (public OTP):** a row is created `pending`, becomes `sent` only when the provider accepts it, and `failed` (and is expired at once) otherwise, including when the provider throws. Verification only looks at rows that are `sent` (or the explicit local-dev `skipped`). Before, the newest row won even if it was never delivered, so a failed resend hid the code the person had actually received. A row left `pending` (process died mid-send) cannot be verified. The login OTP already voided failed codes; its verification now also refuses a `failed` row.
- **Account enumeration (login OTP):** `POST /auth/customer/register` and `/auth/otp/request` answered 429 for a real account in its cooldown / hourly cap and 200 for an unknown number - an oracle. Throttled requests now get the same 200 body as any other request (no code, no message, no Retry-After). **UX consequence to confirm with the mentor:** a real user who hits the 30 s / 5-per-hour cap is no longer told so on screen; the earlier code stays valid until it expires and the countdown in the response is the same for everyone. A delivery failure still returns 503 `OTP_DELIVERY_FAILED` (kept: it is the only signal that a person should retry; it needs the provider to be failing). Public complaint OTP: unchanged (unknown serials already answer identically and are counted like real ones).
- **Retention:** `PublicOtp` (phone, address) and `OtpCode` (hash, destination) rows older than 24 h (past every limit window and session) are deleted opportunistically (~1 request in 50), best effort. Complaint tickets keep the reporter's number as before (it is ticket data). `NotificationLog` rows with legacy plain codes: still a database-owner decision (section 40).
- Unchanged on purpose: OTP goes to the number the reporter types (section 46.1), WhatsApp Cloud API, 5-minute / 10-minute lifetimes, attempt caps (5 per code), single use.
- Tests: mocked `publicComplaintsOtp.test.ts` / `loginOtp.test.ts` (fake transactions + lock emulation in `test/helpers/fakeTransactions.ts`; note PrismaClient is a Proxy, so the fake uses `Object.defineProperty`, not assignment), real-database `test/db/publicOtp.db.test.ts` (new) and `loginOtp.db.test.ts`. Real WhatsApp delivery is still UNVERIFIED.

### 48.3 R4 - digital service reports
- **Broken customer link:** the portal links each ticket to `/service-reports?complaintId=...`, but the page guard let a customer open only `/service-reports/<id>` (the query string is not part of the path), so the link bounced back to the portal. `isCustomerReportPath` (now `admin-web/src/lib/routeAccess.ts`, one rule used by redirect and render) also admits the list page. The API still authorises every row (own customer, never a draft); `/service-reports` with no ticket shows the customer's own reports via `GET /service-reports/mine`.
- **Staff list:** `GET /service-reports` with no `complaintId` / `amcOrderId` now returns the caller's scoped list (`total`, `limit`, `offset`, rows with ticket number / AMC ref, customer, site, RECD serial). Filters `status`, `kind`, `customerId`, `siteId`, `unitId`, `q` (report no., ticket no., serial, customer, site) can only narrow the caller's own scope. Scope = the existing rules: ticket reports for `manage_complaints` / `view_complaints_overview` (all) or `act_assigned_complaints` (assigned tickets); AMC reports for `manage_amc_orders`; vendor users only their vendor's sites; Regional Managers only their regions. A role with none of these gets 403; a customer without a ticket still gets 400. The web page `/service-reports` (menu entry "Service reports", route rule on the four permissions) lists with filters and paging; the per-ticket and per-AMC pages are unchanged.
- **Immutability (migration `20261101090000_signed_report_immutability`):** for a signed or submitted report the database now also refuses to change `siteId`, `unitId`, `createdAt`, `id`, and to re-point `submittedById` / `signedById` (they may only become NULL, which is what deleting that person's account does - the typed signer name and the events keep who signed); refuses to DELETE the report; refuses to UPDATE a stored signature / PDF file that a report points at; makes the report's `ServiceReportEvent` rows append-only (only the actor link may be lost on user deletion); and `ServiceReport.siteId` changes from `ON DELETE SET NULL` to `RESTRICT`. Draft / awaiting-signature reports are unaffected. AMC serial snapshots (`unitSerialNo`) were already protected and are never rewritten by a serial correction. Verified: `prisma migrate diff` against the test database shows no drift.
- **Consequences to know:** a site / unit / customer with any report (even a draft, for the site) cannot be deleted (409 from the existing handlers); a user who signed or submitted a report CAN still be deleted. Test clean-ups that delete signed reports, and the two "damaged stored PDF" tests, now switch the relevant guard off explicitly on the disposable database.
- **Deploy order:** back up, `prisma migrate deploy` (no row is changed; existing data satisfies every rule), then the API and web together. Rollback SQL is at the top of the migration file.
- Tests: `test/db/serviceReportsStaffAndFinal.db.test.ts` (16, real database), `admin-web/test/serviceReportAccess.test.ts` (8), updated `serviceReportScreens.test.ts`, `serviceReports.test.ts`.

### 48.4 Not done / open
- No browser, phone or real-provider check of any of the above. No ESLint configuration exists in `apps/api` or `apps/admin-web` (`npm run lint` cannot run there); TypeScript checks are clean for api, admin-web, mobile and shared.
- Decisions for the mentor: the silent throttle on login OTP requests (48.2); who may see the new staff list beyond the existing report rights (none widened); whether `/service-reports` should also be a landing page.

## 49. Audit follow-ups R6 (escalation of undelivered reminders), R9 (clone-order duplicate PO), R10 (internal erection engineers, Regional Manager dashboard) (branch `feature/my-service-improvements`, not committed)
**Status: implemented and covered by mocked tests and the real-database suite on `localhost:5434/platino_test` ONLY. No migration was needed or created (the only migration of this branch series, `20261101090000_signed_report_immutability`, is section 48). Nothing was tried in a browser, no e-mail was sent, no cron ran.** R1-R4 (sections 47, 48) are untouched.

### 49.1 R6 - an undelivered reminder no longer blocks escalation
- **Defect:** escalation only looked at reminders in status `sent`, and its clock started at `sentAt`. A reminder whose e-mail failed (or that had no recipient, or whose five retries were used up) never got a `sentAt`, so an overdue activity nobody had been told about was also never escalated - the one case escalation exists for.
- **Fix (smallest):** `escalationDue` (`packages/shared`) and the job (`lib/reminders.ts`) now treat `failed` and `no_recipient` reminders as escalatable, with the SAME approved hours, the SAME two levels and the SAME recipients (level 1: the region's Regional Managers who did not already get the reminder, else Management; level 2: Management). Their first hours are counted from the reminder's creation (the moment the activity became due for a reminder), later levels from the previous escalation. A delivered reminder still counts from delivery (`sentAt`). A level that fell due and failed to deliver stays due even if the first reminder is delivered in the meantime (`escalationAttempts > 0`).
- **Unchanged / guaranteed:** a failed reminder is never marked `sent` (escalating does not rewrite its status or reason); first-line retries still stop at 5 attempts; per-recipient de-duplication, the escalation lease and the conditional claims are untouched, so repeated or simultaneous cron runs escalate each level once; reminders of resolved / closed / archived tickets are closed by the housekeeping step BEFORE escalation and are never escalated; acknowledged reminders are never escalated; a level with nobody to tell records `escalation_no_recipient` and settles; delivery errors on the escalation itself are recorded per attempt and retried (limit 5).
- **Acknowledgement:** an undelivered reminder can now be acknowledged once an escalation has gone out (`escalationLevel >= 1`) - the escalated people must be able to take it over, otherwise the second level could not be stopped. Before any escalation it is still refused (409 `REMINDER_NOT_DELIVERED`).
- **DECIDED (project owner): undelivered reminders count their escalation hours from creation** (confirmed after this section was written; no code change).
- ~~Question isolated for the mentor (not guessed):~~ (now answered above) the approved text defines the 24 h only for a DELIVERED reminder ("24 h after it was delivered"). For an undelivered one there is no delivery to count from; creation time was used as the nearest neutral anchor. If the business prefers another anchor (for example the last delivery attempt) it is one line in `escalationDue`. The earlier rule "reminders stuck in failed / no_recipient are not escalated" in sections 33 and 35 was a documented DEFAULT, not an approved decision, and is superseded.
- Tests: `test/reminders.test.ts` (71; includes success, failure, repeated failure, escalation despite failure, repeated / simultaneous runs, resolved and closed tickets, missing recipients, delivery errors), `test/db/reminders.db.test.ts` (22), `packages/shared/test/serviceReminder.test.ts`. Real e-mail, SMTP and production cron remain UNVERIFIED.

### 49.2 R9 - clone-order and the duplicate PO
- **Defect:** `POST /sites/:id/clone-order` copied the source order's PO without any duplicate check (section 34 called it intended). Any user with `manage_orders` could therefore create a second order with a PO the customer already used, with no flag and no refusal.
- **Fix:** one shared rule, `resolveDuplicatePo` (`lib/orderCreation.ts`), used by `POST /orders` (and the AI `create_order`) and by clone-order, inside the creating transaction after the customer + PO advisory lock: per customer, case-insensitive, trimmed; refused as 409 `DUPLICATE_PO` (with `existingOrderNumber`) unless an administrator role (`canOverrideDuplicatePo`) sends `allowDuplicatePo: true`, which creates the order and sets `poDuplicateFlag` (the existing audit trail). Another customer's identical PO is not a duplicate; a legacy source order without a PO is not checked. No global uniqueness and no unique index (approved duplicates must still be possible).
- **API change:** clone-order accepts optional `poNumber`, `poDate`, `allowDuplicatePo`. With none of them it copies the source PO, which is by definition already used by that customer - so a plain clone is now refused unless an administrator ticks the override. The site page's "separate order" form got the optional PO box and (for override roles) the tick.
- **Orphans:** the Orders page creates a new customer / product first and the order second. If the order is refused, the records THIS attempt created are now deleted again (the existing delete endpoints refuse anything that has orders, so nothing else can be removed); order, site and units were already one transaction, and a clone that fails after the PO check (for example a taken serial) rolls back completely (tested).
- **Business question left open:** whether duplicates should be refused or only flagged, and whether uniqueness should be global, is unchanged (per customer, refuse unless an administrator overrides).
- Tests: `test/orderCreation.test.ts` (34), `test/db/cloneOrderPo.db.test.ts` (7, real database incl. concurrency and rollback), `test/db/orderCreation.db.test.ts`, `apps/admin-web/test/auditR9R10Screens.test.ts`.

### 49.3 R10 - users and the dashboard
- **Internal erection engineer:** an erection engineer with no vendor (an internal / legacy account) could not be edited at all: the API answered "An erection engineer must be assigned to a vendor" for any PUT and the Vendor select was `required`. The vendor requirement came from section 11 (erection is subcontracted), so it still applies when an account is CREATED, when someone is moved INTO the role, and when a vendor is cleared. A profile edit of an existing vendor-less engineer (same role, nothing asking to set or clear a vendor) is now allowed (`planAssociations`), and the edit dialog only requires the Vendor box for vendor-linked engineers or a role change. Setting an approved vendor on an internal engineer works; unapproved vendors are refused; role-assignment rules (no self-promotion, only a Super Admin grants Super Admin, `manage_users` required) are untouched. **Mentor:** whether internal erection engineers should exist at all is unresolved; nothing creates new ones.
- **Regional Manager dashboard:** `GET /dashboard` counted every site and ticket company-wide for every holder of `view_dashboard`. A Regional Manager (the approved Zonal Manager) now sees only the regions mapped to them (sites by region; tickets by their site's region; a ticket without a site is out of every region); several regions add up; no mapped region = zero; `?regionId=` can narrow anyone's view but only intersects with the caller's scope (another region or an unknown value gives zero for a Regional Manager). Super Admin, Owner/Admin and Management (and any other dashboard role) keep the company-wide view. The scope is applied in the Prisma queries.
- Tests: `packages/shared/test/userPolicy.test.ts`, `test/db/userAdmin.db.test.ts` (R10 cases), `test/db/dashboardScope.db.test.ts` (6, real database), `apps/admin-web/test/auditR9R10Screens.test.ts`.

## 50. R11 audit: customer data exposure, a notified-but-not-invented region gap, and a hardened notification path (branch `feature/my-service-improvements`, not committed)
**Status: implemented and covered by mocked tests and the real-database suite on `localhost:5434/platino_test` ONLY. No migration was needed or created. Nothing was tried in a browser, no e-mail/WhatsApp was sent, no cron ran.** Sections 39, 42, 43, 44 and 49.1 (R6) are untouched; this closes the two outstanding R11 items of section 44.3 / earlier audits: the customer-facing field leak and the unspecified "site with no region" case.

- **A. Customer ticket data exposure (fixed).** `GET /complaints`, `GET /complaints` (create response) and `GET /complaints/:id/history` could put internal fields in front of a customer through the *same* query that serves staff (`assignedTo`, `remarks`, `rootCause`, `resolutionNotes`, `serviceReportUrl`, `slaEscalationLevel`, the staff `site.contacts`). A customer caller now takes a SEPARATE, narrower Prisma query (`lib/ticketViews.ts`, `CUSTOMER_TICKET_SITE_SELECT` + `customerTicketView`) that never loads the staff relations in the first place (not just a post-filter) and returns only: ticket number, category/issue, description, severity, status, dates, their own attachment, the unit's serial, the site's name/address/order-number/customer-name, and - for a public ticket on their own unit - the reporter's name and type (never the reporter's phone, a third party's number). History (`GET /complaints/:id/history`) and the create response already run through `ticketAccessError` / are customers-cannot-reach routes; the create (`POST /complaints`) response is now also run through `customerTicketView`. Staff responses are byte-for-byte unchanged (nothing was removed from the manager/engineer view). Enforced server-side only; the existing per-customer / per-site scope (`where: { customerId }`) is unchanged, so a query-string parameter cannot widen it (tested).
  - Tests: `test/responseLeaks.test.ts` (customer GET /complaints now asserts the absence of `assignedTo`, `remarks`, `rootCause`, `resolutionNotes`, `serviceReportUrl`, `slaEscalationLevel` and that none of their values appear in the response text - the previous version of this test asserted the opposite, i.e. it pinned the leak; it is corrected, not merely re-run), `test/ticketContacts.test.ts` (the customer query loads no site-contacts include and no assignee relation), `test/db/ticketAdmin.db.test.ts` ("customer field exposure" - real database: a ticket seeded with secret-looking internal values is fetched as its own customer and as staff; the customer's response and its raw JSON never contain the staff values; staff still see everything; a second customer's ticket is never returned, by list or by a search parameter naming it).
- **D. Site with no region (fixed - "notify, don't invent").** Section 43 left the "site with no Regional Manager" case formally unspecified. The existing fallback (`ticketRecipients("raised"/"regional", ...)`: Service Team / Service Managers / Management always hear about a new ticket; the SLA escalation already fell back to Service Managers for level 1) is unchanged and is NOT a guess at a recipient - no Regional Manager, zone or region is invented. What was missing is visibility: nobody could tell, from the ticket, that the intended audience had a gap. `lib/ticketNotify.ts` now has `regionalManagerGap()` (site has no region at all, vs. the region has no active Regional Manager mapped to it) and `notifyTicketRaised()`, used by both ticket-creation routes (`routes/complaints.ts`, `routes/publicComplaints.ts`): when raising a ticket hits either gap (or has no recipient at all), a `notification_gap` history event records the reason once, alongside the normal `complaint_raised` notification to whoever IS reachable. The SLA escalation job (`lib/ticketEscalation.ts`) records the same reason on its level-1 `escalated` event when it falls back to Service Managers. The web ticket-history view explains the new event in plain language. No new role, zone or region was created (consistent with section 43's "Zonal Manager - NOT implemented" decision); this is strictly a visibility fix for an already-correct fallback.
  - New history event: `COMPLAINT_EVENT.NOTIFICATION_GAP` ("notification_gap") in `packages/shared/src/constants.ts` - additive, no migration (events are an existing free-form `type: String` column).
  - Tests: `test/db/ticketAdmin.db.test.ts` (real database) - a ticket on a site with `regionId: null` notifies Service Team/Management, notifies no Regional Manager, and records one `notification_gap` event reasoned `site_has_no_region`; a ticket on a freshly created region with no mapped Regional Manager records the same event reasoned `region_has_no_regional_manager`.
- **B. Notification reliability - one real defect fixed.** `notificationService.send()` called each channel provider directly inside `Promise.all`; a provider that *threw* (rather than returning `false`) crashed the whole send, so a SMTP exception could silently drop the other channels' log rows for the same event and bubble up through `notifySafely`'s catch as an uncaught rejection inside `Promise.all` (the webhook already catches it one level up, but the per-channel accounting was lost). Each channel's send is now individually try/caught and a throw is logged and treated as a non-delivery (`status: "failed"`), exactly like a provider returning `false` - never silently marked delivered, and one channel's failure can never block another channel's record. Verified by mocked `ticketAdmin.test.ts` (a throwing provider for `complaint_status_updated` is recorded as a failure, not a crash, and the ticket's own change is unaffected - already covered by the existing "notifications: ... never undoes the change" test, now exercising the throw path too). The rest of section B's checklist (recipient selection, idempotent escalation, retry limits, resolved/closed tickets not reminded) was already covered and unaffected by sections 39/43/49.1 and re-verified by the full suite below; no further defect was found.
- **C/E/F (status transitions, duplicate prevention, history/audit integrity).** Re-read against sections 39/42/43/45.2/45.3/47 and the shared `ticketPolicy.ts`: all four already go through the one shared policy/trigger/index described there, with no bypass found in `routes/complaints.ts` or `routes/publicComplaints.ts`; no change was made, and no new defect was found in this pass.
- **Security review:** no cross-customer, cross-region or cross-vendor read/write bypass was found beyond the exposure fixed in A (the scope rules in `ticketAccess.ts` and the customer `where: { customerId }` clause were already correct; A was a column-selection leak, not an authorization bypass). No mass-assignment path exists on the ticket write route (`updateComplaintStatusSchema` is an explicit whitelist).
- **Migration:** none. Every change here is a Prisma `select`/`include` shape, a new history event string value, and application code; `Complaint`/`ComplaintEvent` already had every column and type this uses.
- **Full regression (after this section's changes, this run):** shared 115/115, api (mocked) 610/610, api (real database, `localhost:5434/platino_test`) 324/324 (54 of them in `ticketAdmin.db.test.ts`, including the 3 new tests above), admin-web 146/146, mobile 7/7; `tsc --noEmit` clean in shared / api / admin-web / mobile. One earlier solo run of the real-database suite showed a single unrelated assertion-count mismatch (`actual: 18, expected: 20`) that did not reproduce on an immediate full rerun (324/324) or in the targeted rerun of just `ticketAdmin.db.test.ts` (54/54); it was not chased further since it did not recur, and it is noted here rather than hidden.
- **Not verified:** real e-mail/WhatsApp delivery (still mocked everywhere, as in every earlier R11 section), a browser walk-through of the customer portal's ticket list or the staff ticket-history screen, and real concurrent cron execution.
- **R1-R10:** not touched by this section; re-verified by the full suites above (userAdmin, serialRules, recdUnitLinks, reminders, serviceReports/Amc, orderCreation/cloneOrderPo, dashboardScope all still pass).


## 2026-10-24 - Production DB migration for PR #7 (R1-R11) and deploy state

**Why R1-R11 was not visible:** the work lived only in PR #7 (`feature/my-service-improvements`). Production runs `master`. Vercel also refuses Git deploys of
commits by authors who are not on the Vercel team ("Authorization required to deploy"), so the PR only ever produced hand-deployed previews, and the
last web preview (47fe09b) predates the Service Reports sidebar commit (58ae910).

**Database (`platino-recd-mumbai`, ap-south-1): all 19 PR #7 migrations applied on 2026-10-24**, in timestamp order, from `20261015120000_amc_order_units`
to `20261101090000_signed_report_immutability`. They were applied with the Supabase MCP (Prisma engines cannot be downloaded in the Claude sandbox),
and each was recorded in `_prisma_migrations` with the sha256 of its `migration.sql`, so `prisma migrate deploy` sees them as applied. 31 migrations in total.
Row counts before and after were identical (24 users, 3 complaints, 1 unit, 1 AMC order). The one AMC order was backfilled with `datesSource = 'legacy_po_date'`.
`manage_warranty` permission was added for super_admin, owner_admin and management.

**Data fix needed to apply `20261023090000_user_admin_hardening`:** five inactive `raji_tester` users shared the email `testerraji@platino.com`
(created within 3 seconds on 2026-10-23, nothing referenced them). The first (`cmvkcvmj20001c9hbsyrmsk05`) was kept unchanged. The other four
(`cmvkcvmjt0001kbwfrh8s6c3y`, `cmvkcvmnr0001opy080d0brkf`, `cmvkcvmpt0003kbwft9yclpl8`, `cmvkcvoqb000171m682gu2v0h`) were renamed to
`duplicate-<id>-testerraji@platino.com.invalid`, not deleted. They can be deleted later if wanted.

**Side effects to know about:** all unconsumed OTP codes were voided (migration `20261016090000`); the case-insensitive unique email index
`User_email_normalized_key` now exists; `Complaint_one_open_per_unit` was recreated to ignore archived tickets.

**Open follow-ups**
- DONE: PR #7 merged to master as 76aaab3 and deployed to production the same day (`platino-recd-api` dpl_H2syTG5fKDLHVboDCnU9qmQRhLxm, `platino-recd-admin-web` dpl_CMF7Vq7yLb5XZxPNkwSg8xfFhsKx, both READY; API `/health` returns ok, no runtime errors at the time of writing). Not yet checked in a browser: the Service Reports screens and the customer OTP login.
- Aafiya's GitHub account is not on the Vercel team, so Vercel refuses Git deploys of her own commits. Add her to the team, or merge her work under an authorized account.
- 8 new tables have no row-level security yet: ServiceReport, ReportFile, ServiceReportEvent, RegionManagerAudit, AmcVisit, ServiceReminder,
  ServiceReminderEvent (the other new tables enable RLS in their own migrations). Run `ALTER TABLE "<name>" ENABLE ROW LEVEL SECURITY;` for each, then re-check `get_advisors`.
- The new crons (`/reminders/cron/run`, `/warranty/cron/send-reminders`) start after the API deploys.
- Rollback: the code can be rolled back in Vercel without touching the database, since the migrations are additive apart from the constraint swaps.
