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

**Database:** Supabase Postgres (region `ap-northeast-1`), reached via **poolers** (direct connection needs IPv6) — transaction pooler `:6543?pgbouncer=true` for queries, session pooler `:5432` for migrations. Migration applied + seeded. Creds live only in gitignored `apps/api/.env`.

## 3. Core architecture principle — "data, not code"
Anything that might grow a new value later — **stages, roles, permissions, statuses, photo checkpoints, structure types** — is a **row in a table**, never a hardcoded enum. Adding a new stage/role/status later is a DB insert, not a code change. The only real enum is the structural `SitcPhase`. This is the literal mechanism behind "keep everything future‑ready."

Same pattern for **notifications** (one `NotificationService.send()` with real In‑App/Email providers + stubbed SMS/WhatsApp/Telegram behind the same interface) and the **structure‑diagram generator** (Phase‑2 stub behind an interface).

## 4. Roles & access model (central to the app)
**Super Admin ≠ Management** — this was a deliberate split for commercialization:
- **Super Admin** — the *only* role with `manage_settings`. Owns the white‑label/branding (logo, theme) for when the app is sold to other manufacturers. Full access otherwise.
- **Management** (Owner/Proprietor/CEO/CTO) — everything **except** Settings.
- **Sales** — orders. **Operations/PM** — site status + pending actions. **Erection/Commissioning Engineers** — update site status + act on complaints *assigned to them*. **Service Team** — triage/assign/resolve complaints. **Finance** — placeholder (no modules yet). **Customer** — own order/site only, raise complaints, resolve their own approvals.

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

## 11. Mobile-responsive UI (this pass)
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
