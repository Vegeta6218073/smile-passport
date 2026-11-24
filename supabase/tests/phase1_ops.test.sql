-- pgTAP tests for Phase 1 operations. Run with `supabase test db`
begin;
select * from no_plan();

insert into auth.users (id, email) values
  ('f1000000-0000-0000-0000-000000000001', 'owner@p1.local'),
  ('f1000000-0000-0000-0000-000000000002', 'desk@p1.local');
insert into clinics (id, name) values ('f2000000-0000-0000-0000-000000000001', 'Clinic P1');
insert into clinic_members (clinic_id, user_id, role) values
  ('f2000000-0000-0000-0000-000000000001', 'f1000000-0000-0000-0000-000000000001', 'owner'),
  ('f2000000-0000-0000-0000-000000000001', 'f1000000-0000-0000-0000-000000000002', 'front_desk');
insert into patients (id, clinic_id, full_name, phone) values
  ('f3000000-0000-0000-0000-000000000001', 'f2000000-0000-0000-0000-000000000001', 'Pat One', '9200000001');
insert into message_templates (clinic_id, key, language, body, approved)
values ('f2000000-0000-0000-0000-000000000001', 'appointment_reminder', 'en', 'Reminder {{1}}', true);
insert into appointments (id, clinic_id, patient_id, starts_at, ends_at, visit_type)
values ('f4000000-0000-0000-0000-000000000001', 'f2000000-0000-0000-0000-000000000001',
        'f3000000-0000-0000-0000-000000000001', now() + interval '12 hours', now() + interval '12 hours 30 minutes', 'new');

-- ===== WhatsApp opt-in gate (superuser = the worker) =====
select throws_ok(
  $$insert into outbound_messages (clinic_id, patient_id, kind)
    values ('f2000000-0000-0000-0000-000000000001', 'f3000000-0000-0000-0000-000000000001', 'appointment_reminder')$$,
  'P0001', 'patient has not opted in to WhatsApp', 'cannot queue a message without opt-in');
select is(enqueue_appointment_reminders(), 0, 'no reminder for a patient who has not opted in');

insert into whatsapp_opt_events (clinic_id, patient_id, event, source)
values ('f2000000-0000-0000-0000-000000000001', 'f3000000-0000-0000-0000-000000000001', 'opt_in', 'registration');
select is(enqueue_appointment_reminders(), 1, 'one reminder queued after opt-in');
select is(enqueue_appointment_reminders(), 0, 'enqueueing again adds nothing');
select is((select status from outbound_messages), 'queued', 'reminder is queued');

insert into whatsapp_opt_events (clinic_id, patient_id, event, source)
values ('f2000000-0000-0000-0000-000000000001', 'f3000000-0000-0000-0000-000000000001', 'opt_out', 'whatsapp_stop');
select is((select status from outbound_messages), 'blocked_no_opt_in', 'opt-out blocks the queued reminder at once');

-- ===== Patients =====
select throws_ok(
  $$insert into patients (clinic_id, full_name, phone, dob)
    values ('f2000000-0000-0000-0000-000000000001', 'Kid', '9200000009', current_date - interval '5 years')$$,
  'P0001', 'a guardian name is required for patients under 18', 'a minor needs a guardian');

-- ===== Front desk =====
select set_config('request.jwt.claims',
  '{"sub":"f1000000-0000-0000-0000-000000000002","role":"authenticated"}', true);
set local role authenticated;

select is((select count(*) from find_duplicate_patients('+91 92000-00001')), 1::bigint,
  'duplicate phone is found despite formatting');

select lives_ok(
  $$select book_appointment('f3000000-0000-0000-0000-000000000001', null, 'C1', current_date + 3, '10:00', 30, 'follow_up')$$,
  'front desk can book');
select is((select count(*) from appointments_for_day(current_date + 3)), 1::bigint, 'the booking shows on its day');
select throws_ok(
  $$select book_appointment('f3000000-0000-0000-0000-000000000001', null, 'C1', current_date + 3, '10:15', 30, 'follow_up')$$,
  '23P01', null, 'overlapping chair booking is rejected');

insert into enquiries (id, clinic_id, name, phone, lead_source)
values ('f5000000-0000-0000-0000-000000000001', 'f2000000-0000-0000-0000-000000000001', 'Lead', '9200000010', 'instagram');
select lives_ok($$select advance_enquiry('f5000000-0000-0000-0000-000000000001', 'first_reply')$$, 'stamp first reply');
select is((select status from enquiries), 'contacted', 'status moves forward');
select ok((select first_replied_at from enquiries) is not null, 'first reply is timestamped');
select throws_ok($$select advance_enquiry('f5000000-0000-0000-0000-000000000001', 'lost')$$,
  'P0001', 'a reason is required when an enquiry is lost', 'losing an enquiry needs a reason');

-- Tasks: own tasks only for front desk
insert into tasks (id, clinic_id, assignee_id, title, due_at) values
  ('f6000000-0000-0000-0000-000000000001', 'f2000000-0000-0000-0000-000000000001',
   'f1000000-0000-0000-0000-000000000002', 'Call Pat One', now()),
  ('f6000000-0000-0000-0000-000000000002', 'f2000000-0000-0000-0000-000000000001',
   'f1000000-0000-0000-0000-000000000001', 'Owner task', now());
select is((select count(*) from tasks), 1::bigint, 'front desk sees only their own task');
select throws_ok(
  $$insert into tasks (clinic_id, assignee_id, title)
    values ('f2000000-0000-0000-0000-000000000001', 'f1000000-0000-0000-0000-0000000000ff', 'Ghost')$$,
  'P0001', 'assignee is not an active member of this clinic', 'assignee must be a member');
select throws_ok($$select complete_task('f6000000-0000-0000-0000-000000000001', ' ')$$,
  'P0001', 'an outcome is required', 'a task needs an outcome');
select lives_ok($$select complete_task('f6000000-0000-0000-0000-000000000001', 'Left voicemail')$$, 'complete own task');

-- ===== Owner =====
reset role;
select set_config('request.jwt.claims',
  '{"sub":"f1000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
set local role authenticated;

select is((select count(*) from tasks), 2::bigint, 'owner sees every task');
select is((select count(*) from today_queue where kind = 'task'), 1::bigint, 'only the open task is queued');

reset role;
select * from finish();
rollback;
