# Smile Passport intake: how the journey maps to the product

Source: "Smile Passport, User Journey (Version 1)", 28 Jun 2026.

| Journey step | In the product | Status |
|---|---|---|
| 1. Landing page | `/smile`. Headline "Understand your smile." and the CTA "Start My Smile Scan". Visits are counted (`funnel_daily`). | Built |
| 2. Scan: front smile, front teeth, optional side profile | `/smile/scan` and `/api/smile/submit`. Photos checked by file header (JPEG, PNG, WebP, under 8 MB), stored in the private `clinic-files` bucket. Consent is required; WhatsApp consent is separate. | Built |
| 3. Instant AI result | **Deliberately not built.** The doc's Stage 1 and 5 say to review manually and learn which metrics matter before building a Smile Score. The thank-you page promises the review, not a score. | Deferred by design |
| 4. Celebrity comparison | **Deliberately not built.** The doc's own doubt: it could turn the product into entertainment. Revisit as a bonus after launch. | Deferred by design |
| 5. Professional review within 24 hours | `/scans` (deadline alert tasks added 25 Nov, see `automation.md`): the review clock starts at submission (`review_due_at`), pending scans show on the Today queue, and overdue ones are flagged. A doctor claims the scan, writes the report (observations, areas to evaluate, options, duration, next steps), and `/report/[id]` prints it with the screening disclaimer. | Built |
| 6. Consultation routing | The database routes by city: clinic `home_cities` (Vizag) go to the home clinic's booking link; everyone else is a referral, assigned to a partner from `referral_partners` (your BNI network). | Built |
| Four numbers | `/funnel`: visitors, scans, reviews delivered, consultations booked, plus treatments started, with step conversion. | Built |
| Stage 8: charge from day one | Clinic `review_fee_inr` is shown on the landing page and tracked per scan (pending or paid), and credited toward treatment in the wording. **Payment is marked by staff**; there is no online payment yet. | Partly built |
| Stage 7: WhatsApp as CRM | Scan to patient conversion (`convert_scan_to_patient`) carries consent over, and the "Open WhatsApp chat" link is only offered when the person agreed to WhatsApp. Sending is manual. | Partly built |

## Decisions to confirm

- The landing headline differs from the doc ("Discover Your Smile in 30 Seconds") because there is no instant result. Change the copy in `src/app/smile/page.tsx` if you prefer the original.
- Photos are private to owner, doctor and coordinator. Front desk cannot see scans.
- Reports are shared as a PDF by staff, never by public link.

## Not built yet

- Online payment for the review fee.
- Sending the report automatically (the worker can send reminders, but the report itself is still shared by staff).
- AI-assisted measurements (the doc's Stage 2), and the Smile Score.
- Consent wording is a placeholder (`draft-v0`) until counsel reviews it. Do not collect real photos before then.
- The per-IP rate limit is per server instance. The per-phone limit (3 a day) is the real guard; add a CAPTCHA if abuse appears.
