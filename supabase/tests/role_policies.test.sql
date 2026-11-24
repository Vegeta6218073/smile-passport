-- pgTAP tests: role-specific access and opt-in sync. Run with `supabase test db`
begin;
select * from no_plan();

insert into auth.users (id, email) values
  ('dddddddd-0000-0000-0000-0000000000d1', 'doc@test.local'),
  ('dddddddd-0000-0000-0000-0000000000f1', 'desk@test.local');
insert into clinics (id, name) values ('dddddddd-0000-0000-0000-000000000001', 'Role Clinic');
insert into clinic_members (clinic_id, user_id, role) values
  ('dddddddd-0000-0000-0000-000000000001', 'dddddddd-0000-0000-0000-0000000000d1', 'doctor'),
  ('dddddddd-0000-0000-0000-000000000001', 'dddddddd-0000-0000-0000-0000000000f1', 'front_desk');
insert into patients (id, clinic_id, full_name, phone)
values ('dddddddd-0000-0000-0000-000000000101', 'dddddddd-0000-0000-0000-000000000001', 'Pat', '9000000004');
insert into patient_medical (patient_id, clinic_id, medical_history)
values ('dddddddd-0000-0000-0000-000000000101', 'dddddddd-0000-0000-0000-000000000001', '{"note":"x"}');
insert into sop_templates (id, clinic_id, name)
values ('dddddddd-0000-0000-0000-000000000201', 'dddddddd-0000-0000-0000-000000000001', 'Braces');
insert into patient_treatments (id, clinic_id, patient_id, template_id)
values ('dddddddd-0000-0000-0000-000000000301', 'dddddddd-0000-0000-0000-000000000001',
        'dddddddd-0000-0000-0000-000000000101', 'dddddddd-0000-0000-0000-000000000201');
insert into payments (clinic_id, patient_treatment_id, amount_paise, due_date)
values ('dddddddd-0000-0000-0000-000000000001', 'dddddddd-0000-0000-0000-000000000301', 100000, current_date);

-- ===== Front desk =====
select set_config('request.jwt.claims',
  '{"sub":"dddddddd-0000-0000-0000-0000000000f1","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*) from patients), 1::bigint, 'front desk sees patients');
select is((select count(*) from patient_medical), 0::bigint, 'front desk cannot see medical details');
select is((select count(*) from payments), 0::bigint, 'front desk cannot see payments');
select lives_ok(
  $$insert into whatsapp_opt_events (clinic_id, patient_id, event, source)
    values ('dddddddd-0000-0000-0000-000000000001','dddddddd-0000-0000-0000-000000000101','opt_in','registration')$$,
  'front desk can record opt-in');
select is((select whatsapp_opt_in from patients), true, 'opt-in event sets the patient flag');
select lives_ok(
  $$insert into whatsapp_opt_events (clinic_id, patient_id, event, source)
    values ('dddddddd-0000-0000-0000-000000000001','dddddddd-0000-0000-0000-000000000101','opt_out','whatsapp_stop')$$,
  'opt-out can be recorded');
select is((select whatsapp_opt_in from patients), false, 'opt-out clears the patient flag');

-- ===== Doctor =====
reset role;
select set_config('request.jwt.claims',
  '{"sub":"dddddddd-0000-0000-0000-0000000000d1","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*) from patient_medical), 1::bigint, 'doctor sees medical details');
select is((select count(*) from payments), 1::bigint, 'doctor can read payments');
select throws_ok(
  $$insert into payments (clinic_id, patient_treatment_id, amount_paise, due_date)
    values ('dddddddd-0000-0000-0000-000000000001','dddddddd-0000-0000-0000-000000000301',1,current_date)$$,
  '42501', null, 'doctor cannot write payments');

reset role;
select * from finish();
rollback;
