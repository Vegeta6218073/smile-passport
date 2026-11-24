# Smile Passport intake: how the journey maps to the product

Source: "Smile Passport, User Journey (Version 1)", 28 Jun 2026.

| Journey step | In the product | Status |
|---|---|---|
| 1. Landing page | `/smile`. Headline is the Week 1 offer ("a professional smile assessment from an orthodontist within 24 hours, online, from anywhere") and the CTA "Start My Smile Scan". Week 2 sections: hero, how it works, meet the orthodontist (from Settings, hidden until filled in), a sample report, FAQs, upload, book a consultation (home-clinic booking link). Visits are counted (`funnel_daily`), and `?utm_source=` is passed on to the scan form. | Built |
| 2. Scan: front smile, front teeth, optional side profile | `/smile/scan` and `/api/smile/submit`. Photos checked by file header (JPEG, PNG, WebP, under 8 MB), stored in the private `clinic-files` bucket. Consent is required; WhatsApp consent is separate. | Built |
| 3. Instant AI result | **Deliberately not built.** The doc's Stage 1 and 5 say to review manually and learn which metrics matter before building a Smile Score. The thank-you page promises the review, not a score. | Deferred by design |
| 4. Celebrity comparison | **Deliberately not built.** The doc's own doubt: it could turn the product into entertainment. Revisit as a bonus after launch. | Deferred by design |
| 5. Professional review within 24 hours | `/scans` (deadline alert tasks added 25 Nov, see `automation.md`): the review clock starts at submission (`review_due_at`), pending scans show on the Today queue, and overdue ones are flagged. A doctor claims the scan, writes the report (observations, areas to evaluate, options, duration, next steps), and `/report/[id]` prints it with the screening disclaimer. | Built |
| 6. Consultation routing | The database routes by city: clinic `home_cities` (Vizag) go to the home clinic's booking link; everyone else is a referral, assigned to a partner from `referral_partners` (your BNI network). | Built |
| Four numbers | `/funnel`: visitors, scans, reviews delivered, consultations booked, plus treatments started, with step conversion. | Built |
| Day 90 targets | `/funnel?days=90` shows each step against 100 assessments, 30 reviews, 10 consultations, 3 to 5 treatment starts. | Built |
| Stage 9 and Month 3: where people drop off | `/funnel` names the step with the lowest conversion. | Built |
| Week 3: measure how long each step takes | `/funnel` shows the share of reports sent within 24 hours and the average hours from upload to report sent. | Built |
| Week 4: feedback questions | On the scan page after the report is sent, staff record "Was uploading easy?", "Did the report make sense?", "Would you recommend?" and what confused them (`record_scan_feedback`). `/funnel` summarises it. | Built |
| Month 2: content leads to the assessment | Give each piece of content a link like `/smile?utm_source=youtube-braces-faq`. `/funnel` breaks scans, reviews, consultations and treatments down by source. | Built |
| Stage 8: charge from day one | Clinic `review_fee_inr` is shown on the landing page and tracked per scan (pending or paid), and credited toward treatment in the wording. **Payment is marked by staff**; there is no online payment yet. | Partly built |
| Stage 7: WhatsApp as CRM | Scan to patient conversion (`convert_scan_to_patient`) carries consent over, and the "Open WhatsApp chat" link is only offered when the person agreed to WhatsApp. Sending is manual. `/scans/export` downloads the CRM spreadsheet (name, country, photos received, report sent, consultation booked, treatment accepted, payment, feedback) for owner and coordinator. | Partly built |

## Decisions to confirm

- The landing headline uses the Week 1 offer sentence, not "Discover Your Smile in 30 Seconds", because there is no instant result. Change the copy in `src/app/smile/page.tsx` if you prefer the original.
- The sample report and FAQ answers on `/smile` are placeholder copy written for an imaginary patient. The orthodontist should review them (especially the example duration) before launch.
- Fill in the orthodontist's name and a short bio in Settings so the "Meet your orthodontist" section appears.
- "Request a review" (the plan's Stage 9 example: 400 uploads, 250 request a review) is not a separate step, because every scan is a review request. It becomes one if a free AI screening is added later.
- Photos are private to owner, doctor and coordinator. Front desk cannot see scans.
- Reports are shared as a PDF by staff, never by public link.

## Not built yet

- Online payment for the review fee.
- Sending the report automatically (the worker can send reminders, but the report itself is still shared by staff).
- AI-assisted measurements (the doc's Stage 2), and the Smile Score.
- Consent wording is a placeholder (`draft-v0`) until counsel reviews it. Do not collect real photos before then.
- The per-IP rate limit is per server instance. The per-phone limit (3 a day) is the real guard; add a CAPTCHA if abuse appears.
