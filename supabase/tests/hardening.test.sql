-- pgTAP tests for the hardening migration. Run with `supabase test db`
begin;
select * from no_plan();

-- Fixture (as superuser)
insert into auth.users (id, email) values
  ('e1000000-0000-0000-0000-000000000001', 'owner@h.local'),
  ('e1000000-0000-0000-0000-000000000002', 'desk@h.local'),
  ('e1000000-0000-0000-0000-000000000003', 'doc@h.local');
insert into clinics (id, name) values
  ('e2000000-0000-0000-0000-000000000001', 'Clinic X'),
  ('e2000000-0000-0000-0000-000000000002', 'Clinic Y');
insert into clinic_members (clinic_id, user_id, role) values
  ('e2000000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000001', 'owner'),
  ('e2000000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000002', 'front_desk'),
  ('e2000000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000003', 'doctor');
insert into patients (id, clinic_id, full_name, phone) values
  ('e3000000-0000-0000-0000-000000000001', 'e2000000-0000-0000-0000-000000000001', 'Pat X', '9100000001'),
  ('e3000000-0000-0000-0000-000000000002', 'e2000000-0000-0000-0000-000000000002', 'Pat Y', '9100000002');

-- A published two-step SOP in clinic X, and a treatment started from it
insert into sop_templates (id, clinic_id, name) values
  ('e4000000-0000-0000-0000-000000000001', 'e2000000-0000-0000-0000-000000000001', 'Braces');
insert into sop_steps (clinic_id, template_id, position, name, days_after_previous) values
  ('e2000000-0000-0000-0000-000000000001', 'e4000000-0000-0000-0000-000000000001', 1, 'Records', 0),
  ('e2000000-0000-0000-0000-000000000001', 'e4000000-0000-0000-0000-000000000001', 2, 'Placement', 7);
select publish_sop('e4000000-0000-0000-0000-000000000001', 'Dr Test');
select start_treatment('e3000000-0000-0000-0000-000000000001', 'e4000000-0000-0000-0000-000000000001');

select is((select status from sop_templates where id = 'e4000000-0000-0000-0000-000000000001'),
  'published', 'publish_sop publishes with sign-off');
select ok((select due_at from treatment_steps where position = 1 and clinic_id = 'e2000000-0000-0000-0000-000000000001') is not null,
  'first step gets a due date');

-- ===== Owner of clinic X =====
select set_config('request.jwt.claims',
  '{"sub":"e1000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
set local role authenticated;

select ok(mfa_ok(), 'a user with no verified factor passes the MFA check');

select throws_ok(
  $$insert into appointments (clinic_id, patient_id, starts_at, ends_at, visit_type)
    values ('e2000000-0000-0000-0000-000000000001', 'e3000000-0000-0000-0000-000000000002',
            now() + interval '2 days', now() + interval '2 days 30 minutes', 'new')$$,
  '23503', null, 'appointment cannot reference a patient of another clinic');
select throws_ok(
  $$insert into whatsapp_opt_events (clinic_id, patient_id, event, source)
    values ('e2000000-0000-0000-0000-000000000001', 'e3000000-0000-0000-0000-000000000002', 'opt_in', 'staff')$$,
  '23503', null, 'opt-in event cannot flip a patient of another clinic');

select lives_ok(
  $$insert into appointments (clinic_id, patient_id, doctor_id, chair, starts_at, ends_at, visit_type)
    values ('e2000000-0000-0000-0000-000000000001', 'e3000000-0000-0000-0000-000000000001',
            'e1000000-0000-0000-0000-000000000003', 'C1',
            date_trunc('hour', now()) + interval '48 hours', date_trunc('hour', now()) + interval '48 hours 30 minutes', 'follow_up')$$,
  'first booking works');
select throws_ok(
  $$insert into appointments (clinic_id, patient_id, doctor_id, chair, starts_at, ends_at, visit_type)
    values ('e2000000-0000-0000-0000-000000000001', 'e3000000-0000-0000-0000-000000000001',
            null, 'C1',
            date_trunc('hour', now()) + interval '48 hours 15 minutes', date_trunc('hour', now()) + interval '48 hours 45 minutes', 'follow_up')$$,
  '23P01', null, 'a chair cannot be double-booked');
select throws_ok(
  $$insert into appointments (clinic_id, patient_id, doctor_id, chair, starts_at, ends_at, visit_type)
    values ('e2000000-0000-0000-0000-000000000001', 'e3000000-0000-0000-0000-000000000001',
            'e1000000-0000-0000-0000-000000000003', 'C2',
            date_trunc('hour', now()) + interval '48 hours 10 minutes', date_trunc('hour', now()) + interval '48 hours 20 minutes', 'follow_up')$$,
  '23P01', null, 'a doctor cannot be double-booked');
select lives_ok(
  $$insert into appointments (clinic_id, patient_id, doctor_id, chair, starts_at, ends_at, visit_type)
    values ('e2000000-0000-0000-0000-000000000001', 'e3000000-0000-0000-0000-000000000001',
            'e1000000-0000-0000-0000-000000000003', 'C1',
            date_trunc('hour', now()) + interval '48 hours 30 minutes', date_trunc('hour', now()) + interval '49 hours', 'follow_up')$$,
  'back-to-back slots are allowed');

-- SOP rules
insert into sop_templates (id, clinic_id, name)
values ('e4000000-0000-0000-0000-000000000002', 'e2000000-0000-0000-0000-000000000001', 'Retainers');
select throws_ok($$select publish_sop('e4000000-0000-0000-0000-000000000002', 'Dr Test')$$,
  'P0001', 'a SOP needs at least one step', 'cannot publish an empty SOP');
insert into sop_steps (clinic_id, template_id, position, name)
values ('e2000000-0000-0000-0000-000000000001', 'e4000000-0000-0000-0000-000000000002', 1, 'Scan');
select throws_ok($$select publish_sop('e4000000-0000-0000-0000-000000000002', '  ')$$,
  'P0001', 'clinician sign-off is required to publish', 'cannot publish without sign-off');
select throws_ok(
  $$select start_treatment('e3000000-0000-0000-0000-000000000001', 'e4000000-0000-0000-0000-000000000002')$$,
  'P0001', 'only a published SOP can be started', 'a draft SOP cannot be started');
select lives_ok($$select publish_sop('e4000000-0000-0000-0000-000000000002', 'Dr Test')$$, 'publish with sign-off');
select throws_ok(
  $$insert into sop_steps (clinic_id, template_id, position, name)
    values ('e2000000-0000-0000-0000-000000000001', 'e4000000-0000-0000-0000-000000000002', 2, 'Late edit')$$,
  'P0001', null, 'a published SOP cannot gain steps');
select lives_ok($$select new_sop_version('e4000000-0000-0000-0000-000000000002')$$, 'new version can be drafted');
select is((select count(*) from sop_templates where name = 'Retainers'), 2::bigint, 'two versions exist');

-- ===== Front desk =====
reset role;
select set_config('request.jwt.claims',
  '{"sub":"e1000000-0000-0000-0000-000000000002","role":"authenticated"}', true);
set local role authenticated;

select throws_ok(
  $$select advance_step((select id from treatment_steps where position = 1 and clinic_id = 'e2000000-0000-0000-0000-000000000001'), 'done')$$,
  '42501', null, 'front desk cannot complete a treatment step');
select throws_ok(
  $$insert into sop_templates (clinic_id, name) values ('e2000000-0000-0000-0000-000000000001', 'Sneaky')$$,
  '42501', null, 'front desk cannot create SOPs');

-- ===== Doctor =====
reset role;
select set_config('request.jwt.claims',
  '{"sub":"e1000000-0000-0000-0000-000000000003","role":"authenticated"}', true);
set local role authenticated;

select lives_ok(
  $$select advance_step((select id from treatment_steps where position = 1 and clinic_id = 'e2000000-0000-0000-0000-000000000001'), 'done')$$,
  'doctor can complete the next step');
select is((select status from treatment_steps where position = 1 and clinic_id = 'e2000000-0000-0000-0000-000000000001'),
  'done', 'step is done');
select throws_ok(
  $$select advance_step((select id from treatment_steps where position = 1 and clinic_id = 'e2000000-0000-0000-0000-000000000001'), 'done')$$,
  'P0001', null, 'a finished step cannot be completed again');

reset role;
select * from finish();
rollback;
