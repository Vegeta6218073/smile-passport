# Roadmap v3: where each Phase 2 and 3 feature lives

Source: "S-One Clinic OS, Executive Summary & Product Roadmap (v3)", 16 Nov 2026. Phases 0 and 1 (#1 to #14) are in `README.md`; the Smile Passport journey is in `smile-passport.md`.

Migrations: `20261127000001_phase2_pilot_ops.sql`, `20261128000001_phase3_clinical_depth.sql`. Tests: `supabase/tests/phase2.test.sql`, `phase3.test.sql`, `src/lib/phase2.test.ts`, `phase3.test.ts`, `worker/worker.test.mjs`.

**Status:** written, type-checked, unit-tested, and database-tested inside a rolled-back transaction. Not yet clicked through in a browser, and not run against a real WhatsApp number.

## Phase 2: Pilot-ready operations

| # | Feature | Where | Notes |
|---|---|---|---|
| 15 | Patient import and migration | `/patients/import`, SQL `import_patients` | CSV only (Excel: Save As CSV). Dry run first; duplicates by phone (database and file) skipped; every row re-checked in the database; each run recorded in `patient_imports` for the rehearsal. Imported patients are **not** opted in to WhatsApp. |
| 16 | WhatsApp check-ins | worker `enqueue_checkins`, patient page, `/concerns` | Sent `checkin_days_after` days (default 2) after each completed step, for opted-in patients with an approved `comfort_checkin` template. Otherwise "check in by phone" appears on Today. States: pending, sent, OK, concern, no reply. |
| 17 | AI platform foundation | `src/lib/ai/gateway.ts`, `ai_actions`, Settings > AI | One gateway; per-clinic and per-feature switches; names, phones and emails removed before the provider; every action logged; `review_ai_draft` enforces human approval; acceptance and edit rates on the Dashboard. |
| 18 | AI-drafted enquiry replies | `/enquiries` "Draft a reply" | Uses only the clinic's approved answers and price ranges (Settings) and open slots from the schedule. Says so when nothing matches. English only for now; other languages are handed to staff. Staff approve, edit or discard; nothing is sent automatically. |
| 19 | Reply classification and routing | webhook, `apply_reply_classification` | fine, mild, urgent or unknown, with a topic. Urgent and low-confidence replies always become a concern for the patient's clinician. English and Hindi/Hinglish (Latin and Devanagari); other languages fall to a person. |
| 20 | Patient concern handling | `/concerns`, patient page | Assigned clinician, Today alert (urgent first), acknowledge, resolve with an outcome and the clinician's own label (used for classification agreement). Front desk can raise concerns but not read them. |
| 21 | No-show and lapsed recovery | `/recalls`, worker | A no-show opens a recall; patients in treatment with no visit for `lapsed_after_days` are added. Up to 3 attempts (WhatsApp or call task). A new booking closes it as recovered; otherwise a reason is logged. |
| 22 | Payments, instalments, GST-ready receipts | patient page > Payments, `/receipt/[id]` | Instalment schedule, partial payments, numbered receipts and one invoice per treatment (`PREFIX/2026-27/0001`), seller details frozen on each document. Overdue instalments on Today and a WhatsApp reminder. **GST rate defaults to 0%: the accountant must confirm.** |
| 23 | Emergency visits | patient page | Logged as an attended emergency visit without moving the SOP. A clinician can count it as the next step, or move the next step's date. |
| 24 | Owner dashboard and reports | `/dashboard`, `/dashboard/export` | Conversion, no-show rate, active and delayed cases, billed, collected, overdue; against the previous period; CSV. |
| 25 | Smart Today-queue ranking | `src/lib/queue.ts`, `/today` | Readable rules, one-line reason per item. "Show only mine" filter. |
| 26 | Rule-based drop-off flags | view `dropoff_flags`, Dashboard | 2+ missed visits or 2+ unanswered check-ins in 90 days, or 14+ days behind the SOP. |
| 27 | Usage analytics | `usage_events`, `/api/usage`, Dashboard > Pilot | Route patterns only (ids removed). Owner daily opens and the other pilot success criteria are on the Dashboard. |

## Phase 3: Clinical depth and retention

| # | Feature | Where | Notes |
|---|---|---|---|
| 28 | Treatment plans and estimates | patient page > Plans, `/plan/[id]` | Draft, offer, accept (consent signature recorded, SOP and cost start automatically) or decline with a reason code. Offering and accepting stamp the enquiry funnel. "Quoted but not started" on the Dashboard. |
| 29 | Plan explainer | patient page > Plans | Drafted through the gateway, approved by a clinician (owner or doctor) before sending. English only for now. |
| 30 | Documents and clinical media | patient page > Documents | PDF and images up to 10 MB, type checked from the file's bytes, private bucket, 10-minute links. Front desk no longer reads document records. |
| 31 | Notes and tooth chart | patient page > Clinical record | Notes linked to a visit and SOP step. FDI tooth chart (notation to confirm with the doctor). |
| 32 | Lab and vendor tracking | `/labs`, patient page | Orders linked to the step they hold up; late orders on Today and shown as the cause of delayed cases; on-time rate per lab. |
| 33 | Retention phase after debond | `/sops` | SOPs are "treatment" or "retention". A treatment SOP can name a retention SOP that starts by itself on completion. The retention steps themselves are clinic-defined. |
| 34 | Photos over WhatsApp | webhook, patient page | Stored only with a `photo_use` consent (recorded on the patient page); otherwise not stored and staff are asked to get consent. |
| 35 | Patient feedback | worker `enqueue_feedback_requests`, Dashboard | After a first consultation, half-way through treatment, and after debond. A reply of 1 to 5 is recorded; 1 or 2 alerts the owner privately; 5 sends the Google review link. Scores by doctor. |
| 36 | Analytics dashboard | `/dashboard` | 7, 30 and 365-day views against the previous period, enquiry funnel stage by stage. |
| 37 | Marketing source report | `/dashboard/sources` | Leads, consultations, cases and registrations per source; monthly ad spend for cost per lead and per case; monthly source-field completion. |
| 38 | Duplicate detection and merge | `/patients/duplicates`, patient page > Family | Same phone or same name and birth date. Merge, link as family (shared phone), or mark as different. Merge moves every record, fills blanks, archives the duplicate with a snapshot. |
| 39 | Staff notifications | `/notifications`, top bar, worker | For tasks given to you and concerns assigned to you (urgent flagged). Push to installed devices once VAPID keys are set; push text never contains patient details. |
| 40 | Waitlist and cancellation fill | `/waitlist` | A cancelled future slot is offered to the longest-waiting matching patient for 24 hours; YES creates a "book it" task, NO returns them to the list. |
| 41 | Owner weekly summary | `/dashboard/weekly` | Plain-language, read-only; every line links to its numbers; what is slipping comes first. |

## Decisions and open items

- **AI provider.** Only the built-in rule-based provider exists (`AI_PROVIDER=rules`), so no patient data leaves S-One. Adding a model provider is one file implementing `AiProvider` in `src/lib/ai/`, after counsel signs off (data location, no training on clinic data, sub-processor terms). Clinician-labelled test sets per language must pass before a language goes live.
- **Languages.** Drafts are English only; classification covers English and Hindi/Hinglish. Odia replies go to a person. Confirm launch languages with Sudhanta.
- **GST.** Rate, SAC code and invoice format: the accountant confirms before the payments build is used.
- **Consent wording** (`draft-v0`) for treatment and photo consent: counsel.
- **Tooth notation** (FDI) and the retention SOP intervals: the doctor.
- **Excel import** needs saving as CSV first; a direct .xlsx reader was left out to avoid a large dependency.
- **Push on iPhone** works only after the app is added to the home screen (iOS 16.4+).
