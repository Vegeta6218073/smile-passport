# Phase 0 review and hardening (Nov 23, 2026)

Reviewed: the three migrations, the three pgTAP files, auth, middleware, server actions, CI and config.
**Nothing here has been run.** No Postgres, no npm registry and no TypeScript compiler were available
when this was written, so every fix below is untested. Run the steps at the bottom first.

## Bugs found and fixed

| # | Severity | Finding | Fix (migration 20261123000001 unless noted) |
|---|---|---|---|
| 1 | High | Cross-tenant references. Child tables used plain FKs, so a row in clinic A could point at a patient, appointment or treatment in clinic B. RLS only checked `clinic_id`. | Every reference is now a composite `(id, clinic_id)` foreign key. |
| 2 | High | `sync_whatsapp_opt()` is SECURITY DEFINER and updated any patient id it was given, so an opt event could flip another clinic's patient. | Update is scoped to the event's clinic; the composite FK in #1 also rejects the insert. |
| 3 | High | 2FA was only checked in the Next.js layout. A password-only session could call the API directly, and server actions skip layouts. | Restrictive RLS policy `mfa_required` on every table (needs aal2 once a factor is verified). `requireMember()` now checks 2FA on every page and action. |
| 4 | High | `REQUIRE_2FA=true` only showed a banner. | `requireMember()` redirects to /security until a factor is enrolled. The security page is exempt so it cannot loop. |
| 5 | Medium | Front desk could complete treatment steps and edit SOPs (broad tenant policy on those tables). | Read for all staff; write treatments for owner, doctor, coordinator; write SOPs for owner and doctor. |
| 6 | Medium | `advance_step` reported success when RLS blocked the update (0 rows). | It now raises 42501 when nothing was updated, and refuses steps of non-active treatments. |
| 7 | Medium | SOP versioning was not enforced: published SOPs could be edited, and a SOP could be "published" with no clinician sign-off. | Published or retired SOPs are frozen; sign-off is a CHECK; `publish_sop` and `new_sop_version` added. |
| 8 | Medium | A draft SOP could be started on a patient. | `start_treatment` requires a published SOP. |
| 9 | Medium | Double-booking a doctor or chair was possible. | Exclusion constraints on overlapping `booked` or `arrived` appointments; `ends_at > starts_at`. |
| 10 | Low | `visit_type` lacked `emergency` (roadmap #8); enquiry `status` was free text. | CHECK constraints. |
| 11 | High | **CI database job could not pass:** `supabase start` needs `supabase/config.toml`, which was not committed. | Added a minimal `supabase/config.toml` (TOTP enabled). |
| 12 | Low | Search text went straight into a PostgREST `.or()` filter, so commas or parentheses could change the filter. | `safeSearch()` strips them. |
| 13 | Low | Missing HSTS and Permissions-Policy headers; no build in CI. | Added to `next.config.mjs` and `ci.yml`. |

## Still open (not fixed here)

- **Idle timeout is client-side only.** `IdleSignOut` stops working if the tab closes or JS is blocked. Configure server-side session limits in Supabase (inactivity timeout is a Pro-plan setting) and record the decision.
- **Audit log copies whole rows**, including medical history, into `audit_log`. Decide retention and whether medical rows should log changed field names only (DPDP review).
- **`documents` has no storage bucket policies** (the TODO in migration 1). Do this before any upload feature.
- **Soft-deleted patients remain visible to RLS**; every query must filter `deleted_at`. Consider a view.
- **One clinic per user** (`requireMember` uses `limit(1)`). Fine for the pilot, not for Phase 4.
- **The MFA policy has no pgTAP test.** It needs an `auth.mfa_factors` fixture whose columns vary by Supabase version.
- **CSP is a safe subset**; a full `script-src` needs nonces.
- **No lockfile.** Commit `package-lock.json`, then switch CI to `npm ci`.
- **Consent wording is a placeholder** (`draft-v0`). Counsel must review it before real patient data.
- **Stack mismatch with the build prompt.** The prompt asks for NestJS or FastAPI plus Prisma and Next 15; this repo is Supabase and Next 14. The roadmap lists the stack as "to be decided in Phase 0", so that decision should be written down as ADR 0003.

## First run (do this before anything else)

1. `npm install` then `npm run lint`, `npm run typecheck`, `npm test`.
2. `supabase start`, `supabase db reset`, `supabase test db`. Expect 5 files to pass; fix any failure in the new migrations first.
3. `npm run seed:dev`, sign in as each role and walk: add patient, book, publish SOP, start treatment, complete step.


## Update, 25 Nov 2026: which open items are now closed

| Open item | Status |
|---|---|
| `documents` has no storage policies | **Closed** for files: the private `clinic-files` bucket has role and 2FA rules (migration 20261124000001). The `documents` table itself still has no upload screen. |
| Reminder worker and WhatsApp provider not built | **Built, untested with a real provider.** See `automation.md`. |
| Inbound replies and STOP handling | **Built** (webhook). |
| Staff invitations | **Built** (Settings > Team). Needs the one-time email template setup in `automation.md`. |
| Settings screen for home cities, booking link, fee | **Built.** |
| Smile scan 24-hour deadline reminder | **Built** (worker). |
| Edit patient | **Built.** |
| Idle timeout is browser-only | Still open. |
| Audit log copies whole rows | Still open. Team changes made by the owner are written with the service role, so the audit log shows no acting user for them. |
| Soft-deleted patients visible to the database | Still open. |
| One clinic per person | Still open (the invite flow refuses someone who belongs to another clinic). |
| MFA database rule has no automated test | Still open. |
| Full content-security policy | Still open. |
| Consent wording is a placeholder | Still open: needs counsel. |
