# Platino RECD Tracker

A monorepo for the Platino RECD tracker — a system for tracking orders, sites, and
complaints. It is made up of a REST API, an admin web console, a mobile app, and a
package of shared types.

> **Status: Phase 1.** Email notifications are live; the SMS, WhatsApp, and Telegram
> providers are stubbed and activate once their credentials are configured.

## What's inside

| Workspace          | Stack                                                        |
| ------------------ | ------------------------------------------------------------ |
| `apps/api`         | Express 5 REST API — Prisma (PostgreSQL), JWT auth, Zod      |
| `apps/admin-web`   | Next.js 14 admin console — React 18, Tailwind CSS            |
| `apps/mobile`      | Expo / React Native app — React Navigation                  |
| `packages/shared`  | Zod schemas, types, and constants shared across all apps     |

Tooling is [Turborepo](https://turbo.build) over npm workspaces, in TypeScript.

```
apps/
  api/         REST API (Express + Prisma)
  admin-web/   Admin console (Next.js)
  mobile/      Mobile app (Expo)
packages/
  shared/      Shared schemas, types, and constants
```

## Prerequisites

- Node.js >= 20
- npm 11 (the repo pins `npm@11.13.0` via the `packageManager` field)
- A PostgreSQL database (for the API)

## Getting started

```bash
# 1. Install dependencies for every workspace (run from the repo root)
npm install

# 2. Create your env file and fill in the values
cp .env.example .env
#    At minimum set DATABASE_URL and JWT_SECRET. See .env.example for the
#    full list (database, auth, S3 storage, and notification providers).

# 3. Build the shared package — the API and apps import its compiled output
npm run build --workspace=packages/shared

# 4. Set up the database (run migrations, then seed initial data)
npm run db:migrate
npm run db:seed
```

## Running locally

Start every app in watch mode with Turborepo:

```bash
npm run dev
```

Or run a single workspace:

| App       | Command                                  | URL / notes                        |
| --------- | ---------------------------------------- | ---------------------------------- |
| API       | `npm run dev --workspace=apps/api`       | http://localhost:4000 (`/health`)  |
| Admin web | `npm run dev --workspace=apps/admin-web` | http://localhost:6001              |
| Mobile    | `npm run start --workspace=apps/mobile`  | Expo dev server                    |

## Scripts

Run from the repo root:

| Script               | What it does                            |
| -------------------- | --------------------------------------- |
| `npm run dev`        | Run all apps in watch mode (Turborepo)  |
| `npm run build`      | Build all workspaces                    |
| `npm run lint`       | Lint all workspaces                     |
| `npm run db:migrate` | Run Prisma migrations (`apps/api`)      |
| `npm run db:seed`    | Seed the database (`apps/api`)          |

## API

The API listens on port `4000` by default (override with `PORT`) and exposes a
health check at `GET /health`. Route groups: `/auth`, `/orders`, `/customers`,
`/sites`, `/complaints`, `/pending-actions`, `/dashboard`, `/users`, `/settings`,
and `/meta`.
