# Automation: worker, WhatsApp, invitations

How the background pieces work and how to switch them on. Everything defaults to a safe test mode.

## The worker

`worker/run.mjs` is a small Node program. One pass does three things: queues due appointment reminders, raises Smile scan deadline alerts, then sends what is queued.

```
npm run worker          # one pass, then exit (use with a scheduler)
npm run worker:loop     # a pass every 60 seconds, forever
```

It needs `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in `.env.local`. Keep the service role key on the server only.

**Where to run it:** any always-on process works (a small VM, Railway, Render, Fly). Or run `npm run worker` every minute from a scheduler. Two copies running at once is safe: the database hands each message to only one of them.

**What it does to a message:**
```
appointment booked
  -> enqueue_appointment_reminders()   queued only if opted in, with an approved template
  -> claim_outbound_batch()            a worker takes it and locks it for 5 minutes
  -> re-check opt-in and template      read fresh, just before sending
  -> provider.send()                   WhatsApp (or the dry-run logger)
  -> mark_outbound_sent()              the database re-checks opt-in a final time
  -> delivery receipts (webhook)       sent -> delivered -> read, never backwards
```
On a temporary failure (rate limit, provider down) it retries after 5, 10, 15 minutes and so on, up to 5 attempts. On a permanent failure (bad number, template problem) it stops and records the reason.

**Honest limit:** between "re-check opt-in" and the provider call there is a window of a few milliseconds. If a patient sends STOP in exactly that window, one message can still go. The database blocks everything queued after the STOP.

## What each pass does (Phases 2 and 3)

In order: appointment reminders, scan deadline alerts, comfort check-ins (`enqueue_checkins`), lapsed patients (`enqueue_lapsed_recalls`), recall attempts (`run_recall_sequences`), overdue instalment reminders (`enqueue_payment_reminders`), feedback requests (`enqueue_feedback_requests`), expiring unanswered slot offers (`expire_slot_offers`), sending the queue, then push notifications. Every step is safe to repeat. Each new message type needs an approved template in Settings; without one, the patient gets a call task instead.

The webhook now also sorts replies by urgency (`AI_PROVIDER`, default `rules`), recognises feedback ratings (1 to 5) and YES or NO to a slot offer, and stores patient photos when the patient has given photo consent (it downloads them with `WHATSAPP_ACCESS_TOKEN`).

## Push notifications

Run `npx web-push generate-vapid-keys` once and set `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (a `mailto:` address) for the worker, and the same public key as `NEXT_PUBLIC_VAPID_PUBLIC_KEY` for the web app. Each person turns notifications on per device under Notifications.

## Providers

`WHATSAPP_PROVIDER` chooses how messages are sent:

| Value | Behaviour |
|---|---|
| `dry_run` (default) | Sends nothing. Prints "would send template X to ******3210". Use this to test the full flow for free. |
| `meta_cloud` | WhatsApp Business Cloud API (Meta). Needs `WHATSAPP_PHONE_NUMBER_ID` and `WHATSAPP_ACCESS_TOKEN`. **Written from Meta's documented format but never run against real credentials.** Test with a sandbox number first. |

Another provider (an Indian BSP, say) means adding one file in `worker/providers/` with a `send()` function and one line in `worker/providers/index.mjs`. Nothing else changes.

## Going live with WhatsApp, step by step

1. **Run in dry run first.** Add an enquiry or patient with WhatsApp consent, book an appointment for tomorrow, add an approved-looking template in Settings (tick Approved, any name), run `npm run worker`, and watch the log.
2. **Get a provider account** and finish business verification (this takes days; start early).
3. **Submit your reminder text** as a template, in each language you want. Wait for approval.
4. **Enter the approved name** in Settings > WhatsApp message templates and tick Approved. Placeholders: {{1}} patient first name, {{2}} clinic, {{3}} date, {{4}} time. Your template must use these in this order.
5. **Fill the env vars**, set `WHATSAPP_PROVIDER=meta_cloud`, and test with your own phone number only.
6. **Register the webhook** (below), then send yourself a reminder and reply STOP. Confirm your opt-in switches off.
7. Only then turn it on for patients.

## The webhook (delivery receipts and replies)

`POST /api/whatsapp/webhook` receives events from Meta. It rejects anything not signed with your app secret.

1. In Meta's dashboard, set the callback URL to `https://<your-site>/api/whatsapp/webhook`.
2. Choose any random string as the verify token and put it in both Meta's form and `WHATSAPP_VERIFY_TOKEN`.
3. Put the app secret in `WHATSAPP_APP_SECRET`.
4. Put the clinic's id in `WHATSAPP_CLINIC_ID` (the clinic that owns this WhatsApp number).
5. Subscribe to the `messages` field.

What it does: delivery receipts update the message status. A reply of STOP, STOP ALL or UNSUBSCRIBE opts the patient out at once. Any other reply from a known patient becomes a task. Replies from unknown numbers are logged only. Retries from Meta are safe: duplicates are ignored.

## Smile scan deadline alerts

Part of every worker pass. When a scan's 24-hour review deadline is within 4 hours (or already past) and nobody has reviewed it, one task is created, once, for the reviewing doctor (or the first doctor, or the owner). Scans also show on the Today screen from the moment they arrive.

## Inviting staff

Settings > Team > Invite someone sends an email with a link. The link opens `/auth/confirm`, signs the person in once, and sends them to `/set-password` to choose a password (12 characters or more). After that they sign in normally and follow the usual two-step login rules.

**One-time setup on a hosted Supabase project:** in Authentication > Email Templates, paste the content of `supabase/templates/invite.html` into "Invite user" and `recovery.html` into "Reset password". Locally this is already configured in `supabase/config.toml` (and emails appear in the Supabase Inbucket page). Also set the project's Site URL to your real address and configure an SMTP provider, because the built-in mail sender is for testing only.

Removing access: Settings > Team > Remove access. They lose access on their next request. You cannot remove yourself or the last owner.

## Environment variables added

| Variable | Used by | Purpose |
|---|---|---|
| `SMILE_PASSPORT_CLINIC_ID` | public form, webhook fallback | Clinic that receives Smile scans |
| `WHATSAPP_PROVIDER` | worker | `dry_run` or `meta_cloud` |
| `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_API_VERSION` | worker | Meta sending |
| `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET`, `WHATSAPP_CLINIC_ID` | webhook | Meta receiving |

## Checks to run

```
npm test                      # includes the worker and webhook tests
supabase db reset && supabase test db   # includes the automation test file
```
