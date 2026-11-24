-- pgTAP tests for the automation functions. Run with `supabase test db`
begin;
select * from no_plan();

insert into auth.users (id, email) values
  ('b1000000-0000-0000-0000-000000000001', 'owner@au.local'),
  ('b1000000-0000-0000-0000-000000000002', 'doc@au.local');
insert into clinics (id, name) values ('b2000000-0000-0000-0000-000000000001', 'Clinic AU');
insert into clinic_members (clinic_id, user_id, role) values
  ('b2000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000001', 'owner'),
  ('b2000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000002', 'doctor');
insert into patients (id, clinic_id, full_name, phone) values
  ('b3000000-0000-0000-0000-000000000001', 'b2000000-0000-0000-0000-000000000001', 'Pat Opted', '9400000001'),
  ('b3000000-0000-0000-0000-000000000002', 'b2000000-0000-0000-0000-000000000001', 'Pat Late',  '9400000002');
insert into whatsapp_opt_events (clinic_id, patient_id, event, source) values
  ('b2000000-0000-0000-0000-000000000001', 'b3000000-0000-0000-0000-000000000001', 'opt_in', 'registration'),
  ('b2000000-0000-0000-0000-000000000001', 'b3000000-0000-0000-0000-000000000002', 'opt_in', 'registration');
insert into message_templates (clinic_id, key, language, provider_template_name, body, approved)
values ('b2000000-0000-0000-0000-000000000001', 'appointment_reminder', 'en', 'appt_reminder_en', 'Hi {{1}}', true);
insert into appointments (id, clinic_id, patient_id, starts_at, ends_at, visit_type) values
  ('b4000000-0000-0000-0000-000000000001', 'b2000000-0000-0000-0000-000000000001', 'b3000000-0000-0000-0000-000000000001',
   now() + interval '12 hours', now() + interval '12 hours 30 minutes', 'follow_up'),
  ('b4000000-0000-0000-0000-000000000002', 'b2000000-0000-0000-0000-000000000001', 'b3000000-0000-0000-0000-000000000002',
   now() + interval '13 hours', now() + interval '13 hours 30 minutes', 'follow_up');

-- ===== Queue lifecycle =====
select is(enqueue_appointment_reminders(), 2, 'both opted-in patients get a reminder');
select is((select count(*) from claim_outbound_batch(10)), 2::bigint, 'a worker claims both');
select is((select count(*) from claim_outbound_batch(10)), 0::bigint, 'locked messages are not handed out twice');
select is((select min(attempts) from outbound_messages), 1, 'claiming counts an attempt');

select is(mark_outbound_sent((select id from outbound_messages where patient_id = 'b3000000-0000-0000-0000-000000000001'), 'wamid.1'),
  'sent', 'a message is marked sent');
select lives_ok($$select record_delivery_status('wamid.1', 'delivered')$$, 'delivery receipt');
select is((select status from outbound_messages where provider_message_id = 'wamid.1'), 'delivered', 'status is delivered');
select lives_ok($$select record_delivery_status('wamid.1', 'read')$$, 'read receipt');
select lives_ok($$select record_delivery_status('wamid.1', 'delivered')$$, 'a late delivered receipt');
select is((select status from outbound_messages where provider_message_id = 'wamid.1'), 'read', 'status never moves backwards');
select ok((select delivered_at from outbound_messages where provider_message_id = 'wamid.1') is not null, 'delivery time recorded');

-- Retry then give up
select lives_ok($$select mark_outbound_failed((select id from outbound_messages where patient_id = 'b3000000-0000-0000-0000-000000000002'), 'timeout', true)$$,
  'a retryable failure');
select is((select status from outbound_messages where patient_id = 'b3000000-0000-0000-0000-000000000002'), 'queued',
  'it goes back in the queue');
select ok((select scheduled_for from outbound_messages where patient_id = 'b3000000-0000-0000-0000-000000000002') > now(),
  'with a delay');
update outbound_messages set attempts = 5, locked_at = null where patient_id = 'b3000000-0000-0000-0000-000000000002';
select lives_ok($$select mark_outbound_failed((select id from outbound_messages where patient_id = 'b3000000-0000-0000-0000-000000000002'), 'timeout', true)$$,
  'a failure on the last attempt');
select is((select status from outbound_messages where patient_id = 'b3000000-0000-0000-0000-000000000002'), 'failed',
  'is final after 5 attempts');

-- ===== Inbound =====
select is(record_inbound_message('b2000000-0000-0000-0000-000000000001', '+91 94000-00001', 'Can I come later?', 'wamid.in1'),
  'reply', 'a reply from a known patient is logged');
select is((select count(*) from tasks where title like 'Reply to Pat Opted%'), 1::bigint, 'and becomes a task');
select is(record_inbound_message('b2000000-0000-0000-0000-000000000001', '+91 94000-00001', 'Can I come later?', 'wamid.in1'),
  'duplicate', 'a replayed webhook is ignored');
select is((select count(*) from inbound_messages where provider_message_id = 'wamid.in1'), 1::bigint, 'logged once');
select is(record_inbound_message('b2000000-0000-0000-0000-000000000001', '9400000001', ' stop ', 'wamid.in2'),
  'stop', 'STOP is recognised in any case');
select is((select whatsapp_opt_in from patients where id = 'b3000000-0000-0000-0000-000000000001'), false,
  'STOP opts the patient out');
select is(record_inbound_message('b2000000-0000-0000-0000-000000000001', '9999999999', 'hello', 'wamid.in3'),
  'reply', 'an unknown number is logged without a patient');
select is((select count(*) from inbound_messages where provider_message_id = 'wamid.in3' and patient_id is null), 1::bigint,
  'with no patient attached');

-- Opt-out between claim and send: the gate refuses to mark it sent
insert into whatsapp_opt_events (clinic_id, patient_id, event, source)
values ('b2000000-0000-0000-0000-000000000001', 'b3000000-0000-0000-0000-000000000001', 'opt_in', 'staff');
insert into appointments (id, clinic_id, patient_id, starts_at, ends_at, visit_type)
values ('b4000000-0000-0000-0000-000000000003', 'b2000000-0000-0000-0000-000000000001', 'b3000000-0000-0000-0000-000000000001',
        now() + interval '20 hours', now() + interval '20 hours 30 minutes', 'follow_up');
select is(enqueue_appointment_reminders(), 1, 'a reminder is queued for the new appointment');
update patients set whatsapp_opt_in = false where id = 'b3000000-0000-0000-0000-000000000001';
select is(mark_outbound_sent((select id from outbound_messages where appointment_id = 'b4000000-0000-0000-0000-000000000003'), 'wamid.9'),
  'blocked_no_opt_in', 'the opt-in gate blocks a send after an opt-out');

-- ===== Scan deadline alerts =====
insert into smile_scans (id, clinic_id, full_name, phone, city, consent_data, consent_text_version, submitted_at) values
  ('b5000000-0000-0000-0000-000000000001', 'b2000000-0000-0000-0000-000000000001', 'Soon Due', '9400000010', 'Pune', true, 'draft-v0', now() - interval '21 hours'),
  ('b5000000-0000-0000-0000-000000000002', 'b2000000-0000-0000-0000-000000000001', 'Not Yet',  '9400000011', 'Pune', true, 'draft-v0', now());
select is(enqueue_scan_deadline_alerts(), 1, 'only the scan near its deadline is alerted');
select is(enqueue_scan_deadline_alerts(), 0, 'alerts are not repeated');
select is((select assignee_id from tasks where title like 'Smile scan due soon: Soon Due%'),
  'b1000000-0000-0000-0000-000000000002'::uuid, 'the alert goes to a doctor');

-- ===== Staff cannot call server-only functions =====
select set_config('request.jwt.claims',
  '{"sub":"b1000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
set local role authenticated;
select throws_ok($$select claim_outbound_batch(1)$$, '42501', null, 'staff cannot claim outbound messages');
select throws_ok($$select record_inbound_message('b2000000-0000-0000-0000-000000000001', '1', 'x', 'z')$$,
  '42501', null, 'staff cannot inject inbound messages');

reset role;
select * from finish();
rollback;
