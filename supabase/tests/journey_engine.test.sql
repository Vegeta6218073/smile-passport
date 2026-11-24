-- pgTAP tests: journey engine. Run with `supabase test db`
begin;
select * from no_plan();
set local timezone = 'UTC';

-- Fixture: clinic, patient, template with 3 steps (0, 28, 28 days)
insert into clinics (id, name) values ('cccccccc-0000-0000-0000-000000000001', 'Test Clinic');
insert into patients (id, clinic_id, full_name, phone)
values ('cccccccc-0000-0000-0000-000000000101', 'cccccccc-0000-0000-0000-000000000001', 'Pat', '9000000002');
insert into sop_templates (id, clinic_id, name)
values ('cccccccc-0000-0000-0000-000000000201', 'cccccccc-0000-0000-0000-000000000001', 'Braces');
insert into sop_steps (clinic_id, template_id, position, name, days_after_previous) values
  ('cccccccc-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000201', 1, 'Bonding', 0),
  ('cccccccc-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000201', 2, 'Adjustment 1', 28),
  ('cccccccc-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000201', 3, 'Adjustment 2', 28);
select publish_sop('cccccccc-0000-0000-0000-000000000201', 'Test Clinician');

create temp table t as
select start_treatment('cccccccc-0000-0000-0000-000000000101',
                       'cccccccc-0000-0000-0000-000000000201',
                       null, '2026-12-01T00:00:00Z') as id;

create function step_id(p_treatment uuid, p_pos int) returns uuid language sql as
$$ select id from treatment_steps where patient_treatment_id = p_treatment and position = p_pos $$;

-- 1. Start: three steps created, first is due at start
select is((select count(*) from treatment_steps where patient_treatment_id = (select id from t)), 3::bigint, 'three steps created');
select is((select due_at from treatment_steps where id = step_id((select id from t), 1)),
          '2026-12-01T00:00:00Z'::timestamptz, 'first step due at start');
select is((select due_at from treatment_steps where id = step_id((select id from t), 2)),
          null, 'later steps have no due date yet');

-- 2. Completing step 1 late (Dec 3) sets step 2 due from ACTUAL completion
select complete_step(step_id((select id from t), 1), '2026-12-03T00:00:00Z');
select is((select due_at from treatment_steps where id = step_id((select id from t), 2)),
          '2026-12-31T00:00:00Z'::timestamptz, 'step 2 due 28 days after actual completion');

-- 3. Completing step 2 even later pushes step 3 later (delay propagates)
select complete_step(step_id((select id from t), 2), '2027-01-10T00:00:00Z');
select is((select due_at from treatment_steps where id = step_id((select id from t), 3)),
          '2027-02-07T00:00:00Z'::timestamptz, 'late visit pushes the next step out');

-- 4. Out-of-order completion is rejected
create temp table t2 as
select start_treatment('cccccccc-0000-0000-0000-000000000101',
                       'cccccccc-0000-0000-0000-000000000201',
                       null, '2026-12-01T00:00:00Z') as id;
select throws_ok(
  format($$select complete_step(%L)$$, step_id((select id from t2), 3)),
  'P0001', 'only the next pending step can be completed or skipped', 'cannot skip ahead');

-- 5. Skip: step 2 skipped after step 1 done Dec 3, step 3 due from last real completion
select complete_step(step_id((select id from t2), 1), '2026-12-03T00:00:00Z');
select skip_step(step_id((select id from t2), 2));
select is((select status from treatment_steps where id = step_id((select id from t2), 2)),
          'skipped', 'step 2 marked skipped');
select is((select due_at from treatment_steps where id = step_id((select id from t2), 3)),
          '2026-12-31T00:00:00Z'::timestamptz, 'after a skip, next step due from last completed step');

-- 6. Finishing the last step completes the treatment
select complete_step(step_id((select id from t), 3), '2027-02-07T00:00:00Z');
select is((select status from patient_treatments where id = (select id from t)),
          'completed', 'treatment completes after last step');

-- 7. Delayed view lists overdue pending steps only
update treatment_steps set due_at = '2000-01-01T00:00:00Z'
 where id = step_id((select id from t2), 3);
select is((select count(*) from delayed_steps where patient_treatment_id = (select id from t2)),
          1::bigint, 'overdue pending step appears in delayed_steps');
select is((select count(*) from delayed_steps where patient_treatment_id = (select id from t)),
          0::bigint, 'completed treatment has no delayed steps');

select * from finish();
rollback;
