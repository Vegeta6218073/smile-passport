# Product guide: what the system does

A plain-language tour of everything built so far. No code knowledge needed. For how to run and set things up, see `automation.md`; for the day-by-day list of changes, see `CHANGELOG.md`.

## The idea in one paragraph

One system for a dental or orthodontic clinic. It handles the front-desk basics (patients, appointments, enquiries, tasks), the clinical journey (a step-by-step treatment plan per patient), and the Smile Passport funnel (a stranger uploads photos, an orthodontist reviews them, and the clinic follows up). Every clinic's data is kept separate from every other clinic's, enforced inside the database, not just in the screens.

## Who can do what

| | Owner | Doctor | Coordinator | Front desk |
|---|---|---|---|---|
| Add and edit patients, book appointments, capture enquiries | ✓ | ✓ | ✓ | ✓ |
| Own task list | ✓ | ✓ | ✓ | ✓ |
| See all staff tasks | ✓ | | ✓ | |
| Medical details (allergies, history) | read and write | read and write | read only | **none** |
| Start a treatment and complete steps | ✓ | ✓ | ✓ | **none** |
| Create and publish treatment SOPs | ✓ | ✓ | | |
| Smile scans and photos | ✓ | ✓ | ✓ | **none** |
| Write the Smile Report | ✓ | ✓ | | |
| Funnel numbers | ✓ | | ✓ | |
| WhatsApp templates and referral partners | ✓ | | ✓ | |
| Clinic settings, team invitations | ✓ | | | |
| Patient concerns and check-ins (read and resolve) | ✓ | ✓ | ✓ | raise only |
| Notes, tooth chart, linking emergency visits, moving the schedule | ✓ | ✓ | read only | |
| Payments, receipts, invoices | ✓ | read only | ✓ | |
| Treatment plans and estimates | ✓ | ✓ | ✓ | |
| Dashboard | ✓ | ✓ (no money if the role cannot see it) | ✓ | |
| Import, merge duplicates | ✓ | | ✓ | |
| Recalls and waitlist | ✓ | ✓ | ✓ | ✓ |

The screens hide what a role cannot use, and the database refuses it anyway.

## The modules

**Today** (`/today`): your starting screen. It lists what needs attention: tasks due, treatment steps that are overdue, enquiries nobody has answered within the clinic's target time, Smile scans waiting for review, and today's appointments.

**Patients** (`/patients`): add a patient (name, phone, language, consent, optional WhatsApp agreement), search, edit details, and open a profile. A phone number that already exists triggers a warning. Under-18 patients need a guardian's name. The profile also holds medical details (clinical roles only) and the treatment journey.

**Appointments** (`/appointments`): the day's schedule with booking, rescheduling, and status changes (arrived, completed, no-show, cancelled). The system refuses to book the same doctor or chair twice at overlapping times. Times follow the clinic's time zone.

**Treatment journey** (on each patient, built from **SOPs**): a SOP is a template for a treatment, such as braces: a list of steps with "days after the previous step". A doctor or owner writes the steps and publishes the SOP with a named clinician's sign-off. A published SOP is frozen; to change it you create a new version. Starting a treatment copies the steps to the patient, and completing a step sets the next due date. Overdue steps appear on Today.

**Enquiries** (`/enquiries`): every new lead, with how they found you (required) and how they contacted you. Staff stamp each stage (replied, consultation booked, attended, plan offered, case started, completed, or lost with a reason). The page shows how long each lead waited against the reply target.

**Tasks** (`/tasks`): follow-ups with a due date. Closing a task requires writing the outcome. The system also creates tasks by itself, for example after sending a Smile Report.

**Smile Passport** (`/smile` public, `/scans` and `/funnel` for staff): see `smile-passport.md`.

**Concerns** (`/concerns`): patient problems from check-in replies, WhatsApp messages or phone calls, urgent first, each with a clinician. Resolve with what was done.

**Recalls** (`/recalls`) and **Waitlist** (`/waitlist`): patients who missed a visit or drifted away, and patients who want an earlier slot. Cancelled slots are offered to the waitlist automatically.

**Labs** (`/labs`): lab orders, which ones are late, and which treatment they hold up.

**Dashboard** (`/dashboard`): leads, visits, treatments and money against the previous period; the pilot success criteria; AI draft rates; patients at risk; sources and ad spend (`/dashboard/sources`); and a plain-language weekly summary (`/dashboard/weekly`).

**On each patient**, besides details and the treatment journey: plans and estimates, the clinical record (notes, tooth chart, lab orders), documents and photos, feedback, family links, check-ins and concerns, emergency visits, and payments.

**Notifications** (top bar): tasks given to you and concerns assigned to you, also as phone notifications if you turn them on.

**AI**: drafts replies to enquiries and plan explainers, sorts WhatsApp replies by urgency, and writes the weekly summary. It never sends anything; a person approves every message, and urgent or unclear replies always reach a clinician. It runs inside S-One and can be switched off per clinic or per feature in Settings.

**Settings** (`/settings`): owner and coordinator only. Clinic details (home cities, booking link, review fee, reply target), WhatsApp message templates, and the team (invite, change role, remove access).

**Security** (`/security`): each person can set up two-step login. The owner can require it for everyone with a setting.

## What happens automatically

A background worker (see `automation.md`) runs about once a minute:

1. **Appointment reminders.** About a day before a booked appointment, a WhatsApp reminder is queued, but only for patients who agreed to WhatsApp and only if you have an approved template in their language.
2. **Sending.** Queued messages go out through your WhatsApp provider. Failed ones retry with a growing delay, up to five attempts. Opt-in is checked again right before each send.
3. **Smile scan deadline alerts.** When a scan is within four hours of its 24-hour review deadline, the reviewing doctor gets a task.

4. **Comfort check-ins** a couple of days after each visit, **recalls** for missed visits and lapsed patients, **instalment reminders**, **feedback requests** after key visits, and **push notifications** to staff phones.

When a patient replies, the webhook records it. A reply of STOP removes their WhatsApp permission immediately and cancels anything waiting to send. A rating (1 to 5) answers a feedback request; YES or NO answers a slot offer; a check-in reply is sorted by urgency and anything not clearly fine becomes a concern for a clinician. Any other reply becomes a task for the coordinator. Photos are kept only if the patient gave photo consent.

## Rules the system enforces

- Clinics never see each other's data, and a record in one clinic cannot point at another clinic's patient.
- Consent is required before a patient or a Smile scan is stored.
- No WhatsApp message goes to a patient who has not agreed, and an opt-out takes effect at once.
- Only an owner or doctor can write a clinical report or publish a SOP.
- Photos are private. Staff see them through links that expire after 10 minutes.
- Anyone who has set up two-step login must complete it, including when talking to the database directly.
- Every important change is recorded in an audit log.

## Words used

- **SOP:** standard operating procedure; here, a treatment's step list.
- **Opt-in / opt-out:** the patient's agreement (or withdrawal) to receive WhatsApp messages.
- **Template:** a pre-approved WhatsApp message. WhatsApp does not let businesses send free text first.
- **Worker:** a small program that runs in the background, separate from the website.
- **Webhook:** how WhatsApp tells your system about delivery receipts and replies.
- **Dry run:** the test mode where the worker pretends to send and only logs.
