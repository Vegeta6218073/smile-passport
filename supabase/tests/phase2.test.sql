-- pgTAP tests for Phase 2 (roadmap #15 to #27). Run with `supabase test db`
begin;
select * from no_plan();

-- ---------- Fixture ----------
insert into auth.users (id, email) values
  ('b1000000-0000-0000-0000-000000000001', 'owner@p2.local'),
  ('b1000000-0000-0000-0000-000000000002', 'doc@p2.local'),
  ('b1000000-0000-0000-0000-000000000003', 'desk@p2.local'),
  ('b1000000-0000-0000-0000-000000000004', 'coord@p2.local'),
  ('b1000000-0000-0000-0000-000000000009', 'other@p2.local');
insert into clinics (id, name, gst_rate_bps) values
  ('b2000000-0000-0000-0000-000000000001', 'Clinic P2', 1800),
  ('b2000000-0000-0000-0000-000000000002', 'Other P2', 0);
insert into clinic_members (clinic_id, user_id, role, display_name) values
  ('b2000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000001', 'owner', 'Owner'),
  ('b2000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000002', 'doctor', 'Doc'),
  ('b2000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000003', 'front_desk', 'Desk'),
  ('b2000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000004', 'coordinator', 'Coord'),
  ('b2000000-0000-0000-0000-000000000002', 'b1000000-0000-0000-0000-000000000009', 'owner', 'Other');
insert into patients (id, clinic_id, full_name, phone, whatsapp_opt_in) values
  ('b3000000-0000-0000-0000-000000000001', 'b2000000-0000-0000-0000-000000000001', 'Asha Rao', '9400000001', true),
  ('b3000000-0000-0000-0000-000000000002', 'b2000000-0000-0000-0000-000000000001', 'Ravi Kumar', '9400000002', false);
insert into message_templates (clinic_id, key, language, provider_template_name, body, approved) values
  ('b2000000-0000-0000-0000-000000000001', 'comfort_checkin', 'en', 'comfort_checkin', 'Hi {{1}}, how are your teeth?', true),
  ('b2000000-0000-0000-0000-000000000001', 'no_show_recall', 'en', 'no_show_recall', 'Hi {{1}}, we missed you.', true);
insert into sop_templates (id, clinic_id, name, status, reviewed_by) values
  ('b4000000-0000-0000-0000-000000000001', 'b2000000-0000-0000-0000-000000000001', 'Braces', 'draft', null);
insert into sop_steps (clinic_id, template_id, position, name, days_after_previous) values
  ('b2000000-0000-0000-0000-000000000001', 'b4000000-0000-0000-0000-000000000001', 1, 'Bonding', 0),
  ('b2000000-0000-0000-0000-000000000001', 'b4000000-0000-0000-0000-000000000001', 2, 'Adjustment', 28),
  ('b2000000-0000-0000-0000-000000000001', 'b4000000-0000-0000-0000-000000000001', 3, 'Adjustment 2', 28);
update sop_templates set status = 'published', reviewed_by = 'Dr Doc' where id = 'b4000000-0000-0000-0000-000000000001';

-- Treatment started 60 days ago with the doctor; first step done 3 days ago (check-in is due).
insert into patient_treatments (id, clinic_id, patient_id, template_id, doctor_id, status, started_at)
values ('b5000000-0000-0000-0000-000000000001', 'b2000000-0000-0000-0000-000000000001',
        'b3000000-0000-0000-0000-000000000001', 'b4000000-0000-0000-0000-000000000001',
        'b1000000-0000-0000-0000-000000000002', 'active', now() - interval '60 days');
insert into treatment_steps (id, clinic_id, patient_treatment_id, sop_step_id, position, name, status, completed_at, due_at)
select ('b6000000-0000-0000-0000-00000000000' || position)::uuid, clinic_id,
       'b5000000-0000-0000-0000-000000000001', id, position, name,
       case when position = 1 then 'done' else 'pending' end,
       case when position = 1 then now() - interval '3 days' end,
       case when position = 2 then now() - interval '20 days' end
  from sop_steps where template_id = 'b4000000-0000-0000-0000-000000000001';

-- ===== #16 check-ins (server) =====
select is(enqueue_checkins(), 1, 'one check-in is created for the step completed 3 days ago');
select is((select status from checkins where treatment_step_id = 'b6000000-0000-0000-0000-000000000001'),
  'sent', 'an opted-in patient with an approved template gets it on WhatsApp');
select is((select count(*) from outbound_messages where kind = 'comfort_checkin'), 1::bigint, 'the message is queued');
select is(enqueue_checkins(), 0, 'running again creates nothing new');

-- ===== #19 a check-in reply is classified =====
select is((select result from record_inbound_message('b2000000-0000-0000-0000-000000000001', '+91 94000 00001', 'bracket is poking and bleeding', 'wamid.1')),
  'checkin_reply', 'a reply within 7 days is linked to the open check-in');
select is(apply_reply_classification((select id from inbound_messages where provider_message_id = 'wamid.1'),
  'urgent', 'bleeding', 0.9, 'rules-v1'), 'concern', 'an urgent reply becomes a concern');
select is((select status from checkins where treatment_step_id = 'b6000000-0000-0000-0000-000000000001'),
  'concern', 'the check-in shows the concern state');
select is((select assigned_to from patient_concerns where inbound_message_id = (select id from inbound_messages where provider_message_id = 'wamid.1')),
  'b1000000-0000-0000-0000-000000000002'::uuid, 'the concern goes to the treating doctor');
select is((select severity from patient_concerns limit 1), 'urgent', 'severity is urgent');
select is((select count(*) from ai_actions where feature = 'checkin_classification'), 1::bigint, 'the classification is logged');
select is((select count(*) from tasks where title like 'Reply to Asha%'), 0::bigint, 'a check-in reply does not also create a generic reply task');

-- A normal message from a patient without an open check-in still becomes a task
select is((select result from record_inbound_message('b2000000-0000-0000-0000-000000000001', '9400000001', 'what time is my visit?', 'wamid.2')),
  'reply', 'other replies become reply tasks');
select is(apply_reply_classification((select id from inbound_messages where provider_message_id = 'wamid.2'),
  'unknown', null, 0.3, 'rules-v1'), 'ok', 'an unclear non-check-in message does not raise a concern');
select is((select result from record_inbound_message('b2000000-0000-0000-0000-000000000001', '9999999999', 'hello', 'wamid.3')),
  'unknown_sender', 'unknown numbers are logged only');

-- ===== #20 concerns, as staff =====
select set_config('request.jwt.claims', '{"sub":"b1000000-0000-0000-0000-000000000003","role":"authenticated"}', true);
set local role authenticated;
select lives_ok($$select raise_concern('b3000000-0000-0000-0000-000000000002', 'mild', 'Called: wire is loose')$$,
  'front desk can raise a concern from a phone call');
select is((select count(*) from patient_concerns), 0::bigint, 'front desk cannot read concerns');
select is((select count(*) from checkins), 0::bigint, 'front desk cannot read check-ins');

reset role;
select set_config('request.jwt.claims', '{"sub":"b1000000-0000-0000-0000-000000000009","role":"authenticated"}', true);
set local role authenticated;
select throws_ok($$select raise_concern('b3000000-0000-0000-0000-000000000002', 'mild', 'x')$$,
  '42501', null, 'another clinic cannot raise a concern on this patient');
select is((select count(*) from patient_concerns), 0::bigint, 'another clinic sees no concerns');

reset role;
select set_config('request.jwt.claims', '{"sub":"b1000000-0000-0000-0000-000000000002","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*) from patient_concerns), 2::bigint, 'the doctor sees both concerns');
select lives_ok($$select acknowledge_concern((select id from patient_concerns where severity = 'urgent'))$$, 'doctor acknowledges');
select throws_ok($$select resolve_concern((select id from patient_concerns where severity = 'urgent'), ' ')$$,
  'P0001', 'an outcome is required', 'resolving needs an outcome');
select lives_ok($$select resolve_concern((select id from patient_concerns where severity = 'urgent'), 'Clipped the wire', 'urgent')$$,
  'doctor resolves with their own label');
select is((select n from classification_agreement where ai_label = 'urgent' and clinician_label = 'urgent'), 1::bigint,
  'agreement between AI label and clinician label is counted');

-- #23 emergency visit: logged without moving the SOP, then linked by the clinician
select lives_ok($$select log_emergency_visit('b3000000-0000-0000-0000-000000000001', 'Broken bracket')$$, 'emergency visit logged');
select is((select status from treatment_steps where id = 'b6000000-0000-0000-0000-000000000002'), 'pending',
  'the emergency visit did not advance the SOP');
select lives_ok($$select link_visit_to_step((select id from appointments where visit_type = 'emergency'),
  'b6000000-0000-0000-0000-000000000002')$$, 'the doctor links the visit to the next step');
select is((select status from treatment_steps where id = 'b6000000-0000-0000-0000-000000000002'), 'done', 'linking completed the step');
select lives_ok($$select shift_next_step('b5000000-0000-0000-0000-000000000001', 7)$$, 'the doctor moves the next step by a week');

-- ===== Coordinator: import, payments =====
reset role;
select set_config('request.jwt.claims', '{"sub":"b1000000-0000-0000-0000-000000000004","role":"authenticated"}', true);
set local role authenticated;
select throws_ok($$select shift_next_step('b5000000-0000-0000-0000-000000000001', 7)$$, '42501', null,
  'a coordinator cannot change the clinical schedule');

-- #15 import: dry run writes nothing, commit skips duplicates and errors
select results_eq(
  $$select result from import_patients('[
      {"row":2,"full_name":"New One","phone":"98765 43210"},
      {"row":3,"full_name":"Dup","phone":"+91 9400000001"},
      {"row":4,"full_name":"","phone":"9876500000"},
      {"row":5,"full_name":"Kid","phone":"9876511111","dob":"2020-01-01"},
      {"row":6,"full_name":"Twice","phone":"9876543210"},
      {"row":7,"full_name":"Bad date","phone":"9876522222","dob":"31/01/1990"}
    ]'::jsonb, false) order by row_no$$,
  $$values ('ok'), ('duplicate'), ('error'), ('error'), ('duplicate'), ('error')$$,
  'dry run reports ok, duplicates (database and file) and errors');
select is((select count(*) from patients where full_name = 'New One'), 0::bigint, 'the dry run wrote nothing');
select is((select count(*) from patient_imports where dry_run), 1::bigint, 'the dry run is recorded');
select lives_ok($$select * from import_patients('[{"row":2,"full_name":"New One","phone":"9876543210","lead_source":"instagram"}]'::jsonb, true)$$,
  'commit imports');
select is((select whatsapp_opt_in from patients where full_name = 'New One'), false, 'imported patients are not opted in');

-- #22 instalments and receipts
select is(create_instalment_plan('b5000000-0000-0000-0000-000000000001', 6000000, 3, current_date - 40, 30), 3, 'three instalments');
select is((select sum(amount_paise) from payments where patient_treatment_id = 'b5000000-0000-0000-0000-000000000001'),
  6000000::numeric, 'instalments add up to the total');
select throws_ok($$select record_payment((select id from payments where instalment_no = 1), 9999999, 'cash')$$,
  'P0001', null, 'cannot pay more than is due');
select lives_ok($$select record_payment((select id from payments where instalment_no = 1), 2000000, 'upi')$$, 'payment recorded');
select ok((select number from invoices where kind = 'receipt') ~ '^RCT/[0-9]{4}-[0-9]{2}/0001$', 'receipt numbered per financial year');
select is((select tax_paise from invoices where kind = 'receipt'), 305085::bigint, '18% GST is included in the amount');
select ok((select paid_at is not null from payments where instalment_no = 1), 'the first instalment is fully paid');
select lives_ok($$select issue_treatment_invoice('b5000000-0000-0000-0000-000000000001')$$, 'invoice issued');
select throws_ok($$select issue_treatment_invoice('b5000000-0000-0000-0000-000000000001')$$, 'P0001', null, 'only one invoice per treatment');
select is((select count(*) from today_queue where kind = 'payment_overdue'), 1::bigint,
  'the second (overdue) instalment shows in the Today queue');

-- #24 dashboard and #27 pilot metrics run for the clinic
select is((select collected_paise from owner_dashboard(current_date - 1, current_date)), 2000000::bigint, 'collected money is counted');
select is((select active_treatments from owner_dashboard(current_date - 1, current_date)), 1::bigint, 'one active treatment');
select lives_ok($$select * from pilot_metrics(current_date - 30, current_date)$$, 'pilot metrics run');

-- Front desk sees no payments in the queue
reset role;
select set_config('request.jwt.claims', '{"sub":"b1000000-0000-0000-0000-000000000003","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*) from today_queue where kind = 'payment_overdue'), 0::bigint, 'front desk sees no payment items');
select throws_ok($$select record_payment((select id from payments limit 1), 100, 'cash')$$, null, null,
  'front desk cannot record payments');
select throws_ok($$select * from import_patients('[{"row":1,"full_name":"X","phone":"9876500001"}]'::jsonb, true)$$,
  '42501', null, 'front desk cannot import');
select lives_ok($$select track_usage('page_view', '/patients/[id]')$$, 'usage is tracked');

-- ===== #21 recalls =====
reset role;
insert into appointments (id, clinic_id, patient_id, starts_at, ends_at, visit_type)
values ('b7000000-0000-0000-0000-000000000001', 'b2000000-0000-0000-0000-000000000001',
        'b3000000-0000-0000-0000-000000000001', now() - interval '1 day', now() - interval '1 day' + interval '30 minutes', 'follow_up');
update appointments set status = 'no_show' where id = 'b7000000-0000-0000-0000-000000000001';
select is((select count(*) from recalls where kind = 'no_show' and status = 'open'), 1::bigint, 'a no-show opens a recall');
update recalls set next_attempt_at = now() - interval '1 minute';
select is(run_recall_sequences(), 1, 'the first attempt runs');
select is((select count(*) from outbound_messages where kind = 'no_show_recall'), 1::bigint, 'the recall goes out on WhatsApp');
select is((select attempts from recalls where kind = 'no_show'), 1, 'attempts are counted');
insert into appointments (clinic_id, patient_id, starts_at, ends_at, visit_type)
values ('b2000000-0000-0000-0000-000000000001', 'b3000000-0000-0000-0000-000000000001',
        now() + interval '3 days', now() + interval '3 days 30 minutes', 'follow_up');
select is((select status from recalls where kind = 'no_show'), 'booked', 'a new booking closes the recall as recovered');

-- ===== #26 drop-off flags =====
select lives_ok($$select * from dropoff_flags$$, 'drop-off flags view runs');
update treatment_steps set due_at = now() - interval '30 days' where id = 'b6000000-0000-0000-0000-000000000003';
select ok((select '30 days behind the SOP schedule' = any(reasons) from dropoff_flags
  where patient_id = 'b3000000-0000-0000-0000-000000000001'), 'a patient 30 days behind is flagged with a readable reason');

-- ===== #17 AI review =====
insert into ai_actions (id, clinic_id, feature, draft, model)
values ('b8000000-0000-0000-0000-000000000001', 'b2000000-0000-0000-0000-000000000001', 'plan_explainer', 'Plain words', 'rules-v1'),
       ('b8000000-0000-0000-0000-000000000002', 'b2000000-0000-0000-0000-000000000001', 'enquiry_reply', 'Hello', 'rules-v1');
select set_config('request.jwt.claims', '{"sub":"b1000000-0000-0000-0000-000000000003","role":"authenticated"}', true);
set local role authenticated;
select throws_ok($$select review_ai_draft('b8000000-0000-0000-0000-000000000001', 'x', 'sent')$$, '42501', null,
  'front desk cannot approve a clinical draft');
select lives_ok($$select review_ai_draft('b8000000-0000-0000-0000-000000000002', 'Hello there', 'edited_sent')$$,
  'front desk approves an enquiry reply');
select throws_ok($$select review_ai_draft('b8000000-0000-0000-0000-000000000002', 'again', 'sent')$$, 'P0001', null,
  'a draft is reviewed once');
select is((select edited from ai_draft_stats where feature = 'enquiry_reply'), 1::bigint, 'edit rate is tracked');

reset role;
select * from finish();
rollback;
