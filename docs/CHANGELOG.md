# Changelog

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
