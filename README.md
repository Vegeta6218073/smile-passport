# Smile Passport (S-One Clinic OS)

> **Start with `docs/PRODUCT-GUIDE.md`** (what the system does, in plain language), then `docs/CHANGELOG.md`. Setup for the worker, WhatsApp and invitations is in `docs/automation.md`. **`docs/REVIEW.md`** It lists the Phase 0 bugs fixed on Nov 23, what is still open, and the first-run checklist. Phase 1 code (below) is written but has not been compiled or run.

Phase 0 foundation: Supabase (Postgres, auth, row-level security) and a mobile-first Next.js PWA shell for clinic staff.

> Status: written but not yet installed, built or run. The first thing to do is steps 1 to 8 below and fix anything that fails.

## Project structure

```
smile-passport/
├── README.md
├── package.json              scripts: dev, build, lint, typecheck, test, types, seed:dev
├── next.config.mjs           security headers, service worker cache rule
├── tsconfig.json, .eslintrc.json, .nvmrc, .gitignore
├── .env.example              copy to .env.local
├── .github/workflows/ci.yml  web checks + database tests on every push
├── public/
│   ├── manifest.webmanifest  makes the app installable
│   ├── sw.js                 service worker (caches nothing, receives push later)
│   └── icon.svg
├── scripts/
│   └── create-dev-users.mjs  local-only: dev clinic + one user per role
├── src/
│   ├── middleware.ts         refreshes the session, sends signed-out users to /login
│   ├── app/
│   │   ├── layout.tsx, globals.css, page.tsx
│   │   ├── login/            password sign-in, login/verify = 2FA code step
│   │   ├── no-access/        signed in but not linked to a clinic
│   │   └── (app)/            signed-in area (layout checks role, 2FA level, idle timeout)
│   │       ├── today/        reads the delayed_steps view (placeholder queue)
│   │       ├── patients/     list and add patients through row-level security
│   │       └── security/     enrol a 2FA authenticator
│   ├── components/           IdleSignOut, ServiceWorkerRegister
│   └── lib/
│       ├── roles.ts          roles and role-based navigation (+ roles.test.ts)
│       ├── auth.ts           requireMember(), requireRole()
│       ├── monitoring.ts     error-monitoring hook (vendor not wired yet)
│       └── supabase/         browser, server and middleware clients
├── supabase/
│   ├── migrations/           1 schema + RLS + audit, 2 journey engine, 3 extensions + role matrix
│   └── tests/                pgTAP: tenant isolation, role access, journey engine
└── docs/
    ├── decisions/            0001 staff app (PWA), 0002 AI data handling (draft)
    └── runbooks/             backup-restore drill
```

## How to run it locally

Prerequisites: Node 20, Docker running, Git, and the [Supabase CLI](https://supabase.com/docs/guides/cli).

1. **Install packages.** `npm install`
2. **Initialise Supabase config.** `supabase init` (creates `supabase/config.toml`; keep the existing `migrations` and `tests` folders).
3. **Start the local stack.** `supabase start`. It prints an API URL, an `anon key` and a `service_role key`.
4. **Create your env file.** `cp .env.example .env.local`, then paste the anon key and service_role key.
5. **Apply the migrations.** `supabase db reset`
6. **Run the database tests.** `supabase test db`. All three files should pass. Fix these before building anything on top.
7. **Create dev users.** `npm run seed:dev`. It creates `owner@dev.local`, `doctor@dev.local`, `coordinator@dev.local` and `frontdesk@dev.local` (the script prints the dev-only password). It refuses to run against a non-local database.
8. **Run the app.** `npm run dev`, open http://localhost:3000, sign in as the owner, add a patient, then sign in as front desk and confirm the Patients page still works.
9. **Run the web checks.** `npm run lint`, `npm run typecheck`, `npm test`.

### Turn on 2FA
1. In `supabase/config.toml` set `[auth.mfa.totp]` with `enroll_enabled = true` and `verify_enabled = true`.
2. `supabase stop` then `supabase start`.
3. Sign in, open Security, scan the QR code with an authenticator app, and enter the code.
4. To force everyone to enrol, set `REQUIRE_2FA=true` in `.env.local`.

### Generate database types (optional but recommended)
`npm run types` writes `src/lib/database.types.ts`. Then pass the `Database` type to the three Supabase clients.

## Phase 0 checklist (Nov 16 to Dec 4)

| Feature | Where it lives | Done when |
|---|---|---|
| #1 Multi-tenant | migration 1, `rls_isolation.test.sql` | Tests prove clinic A reads nothing of clinic B |
| #2 Auth, roles, 2FA, sessions | `src/lib/auth.ts`, `login/`, `security/`, `IdleSignOut` | Four roles sign in, 2FA enrolled, idle sign-out works |
| #3 Data model | migrations 1 and 3 | Review with the doctor (tooth notation) and accountant (invoice fields) |
| #4 Audit trail | `audit_row()` trigger | A patient edit shows up in `audit_log` with the user id |
| #5 Consent and privacy | `consents`, `whatsapp_opt_events` | Counsel reviews wording and retention |
| #6 Hosting, backups, monitoring | `ci.yml`, `captureError`, `docs/runbooks` | Hosted project in an India region, restore drill recorded, monitoring vendor wired |

## Deploying to a hosted environment
1. Create a Supabase project in an India region (confirm the available region).
2. `supabase link --project-ref <ref>` then `supabase db push`.
3. Create the first clinic and owner by hand (the seed script is local only).
4. Host the web app in a region close to India (confirm the host's region options), and set the same env variables, without the service_role key.
5. Turn on TOTP in the hosted auth settings and set `REQUIRE_2FA=true`.

## Open items
- Role matrix is a draft: front desk has no access to payments or medical details. Confirm with the clinic.
- Error-monitoring vendor and the AI provider are not chosen yet.
- Commit `package-lock.json` after the first install, then change CI to `npm ci`.
- App icons: only an SVG is included. Add PNG icons if an install prompt does not appear on a target phone.


## Phase 1 additions (Nov 23)

| Roadmap # | Feature | Where it lives |
|---|---|---|
| 7 | Patient database | `patients/` (add, search, duplicate warning, guardian for minors, consent), `patients/[id]` (profile, medical for clinical roles) |
| 8 | Scheduling and visit tagging | `appointments/`, SQL `book_appointment`, `reschedule_appointment`, `set_appointment_status`; no double-booking |
| 9 | SOP editor | `sops/`, SQL `publish_sop`, `new_sop_version`; published SOPs are frozen |
| 10 | Journey engine | `patients/[id]` start treatment, complete or skip steps; guards added in migration 20261123000001 |
| 11 | WhatsApp opt-in and opt-out | Opt-in at registration and on the patient page; `outbound_messages` gate refuses queued or sent messages without opt-in |
| 12 | WhatsApp reminders | **Database side only:** templates, queue, `enqueue_appointment_reminders()`. The sender worker and provider are not built |
| 13 | Enquiries and funnel | `enquiries/`, SQL `advance_enquiry` (stage timestamps, reply time against the SLA) |
| 14 | Staff task queue | `tasks/`, `today/` reads the `today_queue` view |

Not built yet: the reminder worker and WhatsApp provider, inbound reply handling and STOP keywords, staff invitations, patient search-as-you-type in booking (the select lists the first 300), chair and doctor calendar grid.


## Smile Passport intake (Nov 24)

The patient-facing funnel from the Smile Passport journey (28 Jun 2026) is part of the product. See `docs/smile-passport.md` for how each step maps to the code, the deliberate choices, and what is still manual.

- Public: `/smile` (landing), `/smile/scan` (upload form), `POST /api/smile/submit` (validates photos by file header, stores them privately, rate limits).
- Staff: `/scans` (review queue with the 24-hour clock, referral partners), `/scans/[id]` (photos, report, next steps), `/report/[id]` (printable report), `/funnel` (the four numbers).
- Nov 26 (MVP plan): landing page sections, orthodontist profile in Settings, feedback on scans, Day 90 targets and sources on `/funnel`, CSV export at `/scans/export`.
- Setup: set `SMILE_PASSPORT_CLINIC_ID` in `.env.local` (`npm run seed:dev` prints the dev clinic's id). Set the clinic's `home_cities`, `booking_url` and `review_fee_inr` in the `clinics` table (no settings screen yet).


## Phases 2 and 3 (Nov 27 and 28)

Roadmap features #15 to #41: patient import, check-ins and concerns, AI drafts and reply sorting (rule-based, no data leaves S-One), recalls, payments and receipts, emergency visits, dashboard and pilot metrics, plans and estimates, documents, notes and tooth chart, labs, retention SOPs, feedback, sources, duplicates, notifications, waitlist and the weekly summary. Where each one lives and what is still to confirm: `docs/roadmap-status.md`.

New setup: `AI_PROVIDER` and the VAPID keys in `.env.local` (see `.env.example`), and WhatsApp templates for each new message type in Settings.

## Documentation index

| File | For |
|---|---|
| `docs/PRODUCT-GUIDE.md` | Everyone: what each module does, who can do what, what runs automatically |
| `docs/CHANGELOG.md` | What was added, by date, with migration and test file names |
| `docs/automation.md` | Worker, WhatsApp providers, webhook, invitations, environment variables, go-live checklist |
| `docs/smile-passport.md` | How the Smile Passport journey maps to the code |
| `docs/roadmap-status.md` | Where each roadmap feature (#15 to #41) lives, and the decisions still open |
| `docs/REVIEW.md` | Phase 0 review findings and what is still open |
