# Changelog

## 28 Nov 2026: Phase 3, clinical depth and retention (roadmap #28 to #41)

Migration `20261128000001_phase3_clinical_depth.sql`; tests `phase3.test.sql`, `src/lib/phase3.test.ts`. Feature map in `roadmap-status.md`.

- Treatment plans and printable estimates, with consent on acceptance and reason codes on decline; plan explainer drafted by AI and approved by a clinician.
- Documents and photos (private storage), visit notes, FDI tooth chart, lab orders linked to the step they hold up.
- Retention SOPs that start by themselves after debond.
- WhatsApp photos stored only with photo consent; patient feedback ratings with private low-score alerts and Google review prompts.
- Dashboard: week, month and year views, delayed cases with their cause, quoted-not-started, feedback by doctor, sources and ad spend, weekly summary.
- Duplicate detection with merge, family links and "different people".
- Staff notifications in the app and as push (new dependency: `web-push`).
- Waitlist with automatic offers of cancelled slots.
- WhatsApp replies from a phone shared by several patients now go to the patient messaged most recently.

## 27 Nov 2026: Phase 2, pilot-ready operations (roadmap #15 to #27)

Migration `20261127000001_phase2_pilot_ops.sql`; tests `phase2.test.sql`, `src/lib/phase2.test.ts`. Feature map in `roadmap-status.md`.

- Patient import from CSV with dry run and duplicate checks.
- Comfort check-ins on WhatsApp (or by phone), reply sorting by urgency, patient concerns with a clinician and an outcome.
- AI gateway with per-clinic switches, identifier removal, logging and human approval; enquiry reply drafts from approved answers, prices and open slots.
- No-show and lapsed-patient recalls; instalments, partial payments, numbered receipts and invoices (GST-ready); emergency visits.
- Owner dashboard with CSV, ranked Today queue with reasons, drop-off flags, privacy-safe usage analytics and the pilot success criteria.
- `record_inbound_message` now returns a row (result, ids) instead of text; the automation tests were updated.


## 26 Nov 2026: Smile Passport MVP plan

New migration: `20261126000001_smile_passport_mvp.sql`. Tests added to `supabase/tests/smile_passport.test.sql`; unit tests in `src/lib/funnel.test.ts`. Mapping in `smile-passport.md`.

- **Landing page** (`/smile`): Week 1 offer as the headline, plus meet the orthodontist, sample report, FAQs and a booking link. `utm_source` now carries from the landing page to the scan form.
- **Settings:** orthodontist name and bio for the landing page.
- **Feedback** (Week 4 questions) recorded on the scan page after the report is sent.
- **Funnel:** Day 90 targets, biggest drop-off, the 24-hour promise (on-time share, average hours), feedback summary, breakdown by source.
- **CRM spreadsheet:** `/scans/export` downloads every scan as CSV (owner and coordinator). Cells that look like formulas are neutralised.

## 25 Nov 2026: automation, settings, team

New migration: `20261125000001_automation.sql`. New tests: `supabase/tests/automation.test.sql`.

- **Reminder worker** (`worker/`): queues reminders, sends through a provider, retries failures, checks opt-in before every send.
- **Providers:** `dry_run` (default, sends nothing) and `meta_cloud` (WhatsApp Cloud API, untested with real credentials).
- **WhatsApp webhook** (`/api/whatsapp/webhook`): signed delivery receipts and replies. STOP opts the patient out immediately; other replies become tasks.
- **Smile scan deadline alerts:** a task when a scan is within 4 hours of its 24-hour deadline.
- **Settings page** (`/settings`): clinic details (home cities, booking link, review fee, reply target) and WhatsApp templates.
- **Team management:** invite by email, change role, remove or restore access, with guards against removing the last owner.
- **Invite and reset flow:** `/auth/confirm` and `/set-password`, plus email templates; minimum password length 12.
- **Edit patient details** on the patient profile, with the duplicate-phone and minor-guardian rules.
- Roles: new `settings:manage` permission (owner), Settings in the menu for owner and coordinator.

## 24 Nov 2026: Smile Passport intake

Migration `20261124000001_smile_passport_intake.sql`; tests `smile_passport.test.sql`. Details in `smile-passport.md`.

- Public landing page, photo upload form, private photo storage with signed links (10 minutes).
- Review queue with the 24-hour clock, report writing, printable report, referral partners, routing by city, and the funnel page.
- Private file storage rules (`clinic-files` bucket), which any future upload feature will reuse.

## 23 Nov 2026: review and Phase 1 core

Migrations `20261123000001_hardening.sql` and `20261123000002_phase1_ops.sql`; tests `hardening.test.sql`, `phase1_ops.test.sql`. Details in `REVIEW.md`.

- 13 fixes from the Phase 0 review (cross-clinic references, 2FA enforced in the database, role rules, no double-booking, SOP versioning, CI config).
- Patients, appointments, enquiries funnel, tasks, SOP editor, treatment journey, Today queue, WhatsApp opt-in rules.
