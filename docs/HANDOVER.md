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
Staff logins: `superadmin@ / owner@ / sales@ / ops@ / erection@ / commissioning@ / service@ / finance@platino.example`, all password **`changeme123`**. Customer (Track My Order): `ORD-2026-0001` + `+919900011122` (OTP shows on‑screen + in the API terminal).

## 8. Before production / known gaps
- **Rotate secrets:** all seed passwords are `changeme123`, the Supabase DB password has been exposed in chat, and `JWT_SECRET` is a placeholder.
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

**How to reproduce the test locally:** `.env` (root) or `apps/api/.env` needs `DATABASE_URL` + `DIRECT_URL` (Postgres) and `JWT_SECRET`; then `npm run build --workspace=packages/shared`, `prisma migrate deploy`, seed (`tsx apps/api/prisma/seed.ts`), start the API and `next dev -p 6001`. Staff logins are the §7 accounts (all `changeme123`); customer via `ORD-2026-0001` + `+919900011122` (dev OTP echoed on screen). Screenshots for all roles were captured but are not committed (dev artifacts).

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

**New AMC (Annual Maintenance Contract) Order module:** new top-level nav item + page (`/amc-orders`), gated on a new permission `manage_amc_orders` (auto-granted to `super_admin`/`management` since they hold `ALL_PERMISSIONS`). New `AmcOrder` model (poNo, poDate, customerId, location, item, qty, amcFrequencyPerYear, status) + `AMC_ORDER_STATUS` constant (`yet_to_start`/`in_progress`/`completed`). Page shows 4 stat tiles (total/completed/in-progress/yet-to-start), a "Create New Order" modal (customer picker + PO fields), a "Create New Customer" modal (reuses the existing `POST /customers` flow), and the order list table. Routes: `GET /amc-orders` (list + counts), `POST /amc-orders`.

**How this migration was actually applied (read before running `prisma migrate` again):** local `apps/api/.env`'s `DIRECT_URL` could not authenticate against the Mumbai pooler from this dev machine (`P1000: Authentication failed`) despite the same credentials working fine in production via Vercel, and despite raw TCP connectivity to the pooler succeeding. Root cause not identified — flagged as a known local-environment issue, not a credential problem. Worked around by applying the migration SQL directly to production via the Supabase MCP tool (explicit user authorization obtained first — this is a production-write action and the harness blocks it without that), then running `npx prisma generate` locally (schema-only, no DB connection needed) to regenerate the Prisma Client. **`_prisma_migrations` ledger was NOT updated** (the bookkeeping INSERT was also blocked as a production-DB write) — `prisma migrate status` will likely report this migration as pending/drifted even though the schema change is live. Reconcile that (e.g. `prisma migrate resolve --applied 20260715045820_add_amc_orders_company_details_complaint_fields`) once local DB auth is working again, before running any further `prisma migrate dev`.

**RLS:** the new `AmcOrder` table was created with RLS disabled by default (Supabase advisory flagged this); enabled to match every other table's posture (`ENABLE ROW LEVEL SECURITY`, zero policies — same default-deny-to-anon-key pattern already used everywhere else; the app's own Prisma connection bypasses RLS).

**Verified:** `packages/shared`, `apps/api`, `apps/admin-web` all `tsc --noEmit` clean; `npm run build` (admin-web) clean and includes the new `/amc-orders` route. Login-page label changes (RECD Serial Number, User Name) confirmed live in browser. **Not verified end-to-end with real data** — local dev API can't reach the Mumbai DB (same auth issue as above), so the logged-in flows (company details save, complaint submit with attachment, AMC order create, Manage modal remarks/service-report) have only been code-reviewed, not click-tested. First real verification should happen against the Vercel deployment once it redeploys from this push, or once local DB auth is fixed.

**Staff login label:** "Email" → **"User Name"** (display-only; the field is still validated/submitted as an email address and login is still by email — no auth logic changed, this was purely the label text per the mockup).
