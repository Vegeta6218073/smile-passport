-- pgTAP tests for Smile Passport intake. Run with `supabase test db`
begin;
select * from no_plan();

insert into auth.users (id, email) values
  ('a1000000-0000-0000-0000-000000000001', 'owner@sp.local'),
  ('a1000000-0000-0000-0000-000000000002', 'doc@sp.local'),
  ('a1000000-0000-0000-0000-000000000003', 'desk@sp.local'),
  ('a1000000-0000-0000-0000-000000000004', 'coord@sp.local');
insert into clinics (id, name, home_cities, review_fee_inr)
values ('a2000000-0000-0000-0000-000000000001', 'Clinic SP', array['vizag','visakhapatnam'], 999),
       ('a2000000-0000-0000-0000-000000000002', 'Other Clinic', '{}', 0);
insert into clinic_members (clinic_id, user_id, role) values
  ('a2000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001', 'owner'),
  ('a2000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000002', 'doctor'),
  ('a2000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000003', 'front_desk'),
  ('a2000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000004', 'coordinator');

-- Two scans as the public form would insert them (service role / superuser)
insert into smile_scans (id, clinic_id, full_name, phone, city, consent_data, consent_whatsapp, consent_text_version) values
  ('a3000000-0000-0000-0000-000000000001', 'a2000000-0000-0000-0000-000000000001', 'Vizag Visitor', '9300000001', ' Vizag ', true, true, 'draft-v0'),
  ('a3000000-0000-0000-0000-000000000002', 'a2000000-0000-0000-0000-000000000001', 'Pune Visitor',  '9300000002', 'Pune',    true, false, 'draft-v0');

select is((select route from smile_scans where id = 'a3000000-0000-0000-0000-000000000001'),
  'home_clinic', 'a Vizag scan routes to the home clinic, ignoring case and spaces');
select is((select route from smile_scans where id = 'a3000000-0000-0000-0000-000000000002'),
  'referral', 'a scan from elsewhere routes to a referral');
select is((select review_due_at - submitted_at from smile_scans where id = 'a3000000-0000-0000-0000-000000000001'),
  interval '24 hours', 'the review clock is 24 hours');
select is((select payment_status from smile_scans where id = 'a3000000-0000-0000-0000-000000000001'),
  'pending', 'a clinic with a review fee starts the scan as payment pending');
select throws_ok(
  $$insert into smile_scans (clinic_id, full_name, phone, city, consent_data, consent_text_version)
    values ('a2000000-0000-0000-0000-000000000001', 'No Consent', '9300000009', 'Vizag', false, 'draft-v0')$$,
  '23514', null, 'a scan without data-processing consent is refused');

insert into smile_scan_photos (clinic_id, scan_id, kind, storage_path, content_type, bytes)
values ('a2000000-0000-0000-0000-000000000001', 'a3000000-0000-0000-0000-000000000001',
        'front_smile', 'a2000000-0000-0000-0000-000000000001/scans/x/front_smile.jpg', 'image/jpeg', 1000);
select throws_ok(
  $$insert into smile_scan_photos (clinic_id, scan_id, kind, storage_path, content_type, bytes)
    values ('a2000000-0000-0000-0000-000000000001', 'a3000000-0000-0000-0000-000000000001',
            'front_smile', 'dup', 'image/jpeg', 1)$$,
  '23505', null, 'one photo per kind per scan');
select throws_ok(
  $$insert into smile_scan_photos (clinic_id, scan_id, kind, storage_path, content_type, bytes)
    values ('a2000000-0000-0000-0000-000000000002', 'a3000000-0000-0000-0000-000000000001',
            'front_teeth', 'x', 'image/jpeg', 1)$$,
  '23503', null, 'a photo cannot sit in a different clinic from its scan');

select is(storage_clinic('a2000000-0000-0000-0000-000000000001/scans/x.jpg'),
  'a2000000-0000-0000-0000-000000000001'::uuid, 'storage path gives the clinic');
select is(storage_clinic('not-a-uuid/x.jpg'), null::uuid, 'a bad storage path gives no clinic');

-- ===== Front desk sees no scans =====
select set_config('request.jwt.claims',
  '{"sub":"a1000000-0000-0000-0000-000000000003","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*) from smile_scans), 0::bigint, 'front desk cannot see scans');
select is((select count(*) from smile_scan_photos), 0::bigint, 'front desk cannot see scan photos');

-- ===== Coordinator: manages, cannot review =====
reset role;
select set_config('request.jwt.claims',
  '{"sub":"a1000000-0000-0000-0000-000000000004","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*) from smile_scans), 2::bigint, 'coordinator sees scans');
select throws_ok($$select claim_scan('a3000000-0000-0000-0000-000000000001')$$,
  '42501', null, 'a coordinator cannot review a scan');

-- ===== Doctor: the full review path =====
reset role;
select set_config('request.jwt.claims',
  '{"sub":"a1000000-0000-0000-0000-000000000002","role":"authenticated"}', true);
set local role authenticated;

select throws_ok($$select save_report('a3000000-0000-0000-0000-000000000001', 'obs', null, null, null, 'next')$$,
  'P0001', 'claim the scan before writing its report', 'cannot write a report before claiming');
select lives_ok($$select claim_scan('a3000000-0000-0000-0000-000000000001')$$, 'doctor claims the scan');
select throws_ok($$select claim_scan('a3000000-0000-0000-0000-000000000001')$$,
  'P0001', null, 'a scan cannot be claimed twice');
select throws_ok($$select save_report('a3000000-0000-0000-0000-000000000001', '  ', null, null, null, 'next')$$,
  'P0001', 'observations and next steps are required', 'a report needs observations');
select lives_ok($$select save_report('a3000000-0000-0000-0000-000000000001',
  'Mild lower crowding', 'Upper midline', 'Aligners or braces', '12-18 months', 'Book a consultation')$$,
  'doctor writes the report');
select throws_ok($$select mark_consult_booked('a3000000-0000-0000-0000-000000000001')$$,
  'P0001', null, 'cannot book a consultation before the report is sent');
select lives_ok($$select mark_report_sent('a3000000-0000-0000-0000-000000000001')$$, 'report marked sent');
select is((select status from smile_scans where id = 'a3000000-0000-0000-0000-000000000001'),
  'report_sent', 'status moves to report_sent');
select lives_ok($$select mark_consult_booked('a3000000-0000-0000-0000-000000000001')$$, 'consultation booked');
select lives_ok($$select mark_treatment_started('a3000000-0000-0000-0000-000000000001')$$, 'treatment started');

-- The other scan: better photos flow, partner only for referrals
select lives_ok($$select request_better_photos('a3000000-0000-0000-0000-000000000002', 'Teeth are out of focus')$$,
  'doctor asks for better photos');
select throws_ok($$select assign_partner('a3000000-0000-0000-0000-000000000001', null)$$,
  'P0001', 'only referral scans take a partner', 'home-clinic scans take no partner');

-- ===== Owner: coordinator-owned tasks, convert, funnel =====
reset role;
select set_config('request.jwt.claims',
  '{"sub":"a1000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
set local role authenticated;

select is((select count(*) from tasks where source = 'system'), 2::bigint,
  'sending a report and asking for photos each created a task');

select lives_ok($$select convert_scan_to_patient('a3000000-0000-0000-0000-000000000001')$$, 'scan converts to a patient');
select is((select count(*) from patients where phone = '9300000001'), 1::bigint, 'one patient was created');
select is((select count(*) from consents where kind = 'data_processing' and given_by = 'Vizag Visitor'), 1::bigint,
  'consent was carried over');
select is((select whatsapp_opt_in from patients where phone = '9300000001'), true,
  'WhatsApp consent from the form became an opt-in event');
select is((select count(*) from patients where phone = '9300000002'), 0::bigint,
  'a scan without WhatsApp consent created no patient until converted');
select lives_ok($$select convert_scan_to_patient('a3000000-0000-0000-0000-000000000001')$$, 'converting twice is harmless');
select is((select count(*) from patients where phone = '9300000001'), 1::bigint, 'still one patient');

reset role;
select record_visit('a2000000-0000-0000-0000-000000000001');
select record_visit('a2000000-0000-0000-0000-000000000001');
select set_config('request.jwt.claims',
  '{"sub":"a1000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
set local role authenticated;
select results_eq(
  $$select visits, scans, reviews_delivered, consults_booked, treatments_started
      from smile_funnel(current_date - 1, current_date + 1)$$,
  $$values (2::bigint, 2::bigint, 1::bigint, 1::bigint, 1::bigint)$$,
  'funnel counts visits, scans, reviews, consultations and treatments');

reset role;
select * from finish();
rollback;
