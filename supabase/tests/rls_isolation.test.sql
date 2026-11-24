-- pgTAP tests: tenant isolation. Run with `supabase test db`
-- User A (owner of clinic A) must never see or write clinic B's data.
begin;
select * from no_plan();

-- Fixture (as superuser)
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-0000000000a1', 'a@test.local'),
  ('bbbbbbbb-0000-0000-0000-0000000000b1', 'b@test.local');
insert into clinics (id, name) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Clinic A'),
  ('bbbbbbbb-0000-0000-0000-000000000001', 'Clinic B');
insert into clinic_members (clinic_id, user_id, role) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000a1', 'owner'),
  ('bbbbbbbb-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-0000000000b1', 'owner');

-- One row of everything in clinic B
insert into patients (id, clinic_id, full_name, phone)
values ('bbbbbbbb-0000-0000-0000-000000000101', 'bbbbbbbb-0000-0000-0000-000000000001', 'Pat B', '9000000001');
insert into consents (clinic_id, patient_id, kind, text_version, given_by)
values ('bbbbbbbb-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000101', 'treatment', 'v1', 'Pat B');
insert into enquiries (clinic_id, name, phone, lead_source)
values ('bbbbbbbb-0000-0000-0000-000000000001', 'Enq B', '9000000003', 'website');
insert into appointments (clinic_id, patient_id, starts_at, ends_at, visit_type)
values ('bbbbbbbb-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000101', now(), now() + interval '30 minutes', 'new');
insert into sop_templates (id, clinic_id, name)
values ('bbbbbbbb-0000-0000-0000-000000000201', 'bbbbbbbb-0000-0000-0000-000000000001', 'Braces');
insert into sop_steps (clinic_id, template_id, position, name)
values ('bbbbbbbb-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000201', 1, 'Bonding');
insert into patient_treatments (id, clinic_id, patient_id, template_id)
values ('bbbbbbbb-0000-0000-0000-000000000301', 'bbbbbbbb-0000-0000-0000-000000000001',
        'bbbbbbbb-0000-0000-0000-000000000101', 'bbbbbbbb-0000-0000-0000-000000000201');
insert into treatment_steps (clinic_id, patient_treatment_id, position, name)
values ('bbbbbbbb-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000301', 1, 'Bonding');
insert into documents (clinic_id, patient_id, kind, storage_path)
values ('bbbbbbbb-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000101', 'xray', 'b/x.png');
insert into payments (clinic_id, patient_treatment_id, amount_paise, due_date)
values ('bbbbbbbb-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000301', 500000, current_date);

-- ===== Act as user A =====
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;

select is((select count(*) from patients), 0::bigint, 'A sees no patients of B');
select is((select count(*) from consents), 0::bigint, 'A sees no consents of B');
select is((select count(*) from enquiries), 0::bigint, 'A sees no enquiries of B');
select is((select count(*) from appointments), 0::bigint, 'A sees no appointments of B');
select is((select count(*) from sop_templates), 0::bigint, 'A sees no SOP templates of B');
select is((select count(*) from sop_steps), 0::bigint, 'A sees no SOP steps of B');
select is((select count(*) from patient_treatments), 0::bigint, 'A sees no treatments of B');
select is((select count(*) from treatment_steps), 0::bigint, 'A sees no treatment steps of B');
select is((select count(*) from documents), 0::bigint, 'A sees no documents of B');
select is((select count(*) from payments), 0::bigint, 'A sees no payments of B');
select is((select count(*) from audit_log), 0::bigint, 'A sees no audit rows of B');
select is((select count(*) from clinics), 1::bigint, 'A sees only own clinic');
select throws_ok(
  $$insert into patients (clinic_id, full_name, phone)
    values ('bbbbbbbb-0000-0000-0000-000000000001', 'Intruder', '1')$$,
  '42501', null, 'A cannot insert into clinic B');

-- ===== Act as user B =====
reset role;
select set_config('request.jwt.claims',
  '{"sub":"bbbbbbbb-0000-0000-0000-0000000000b1","role":"authenticated"}', true);
set local role authenticated;

select is((select count(*) from patients), 1::bigint, 'B sees own patient');
select is((select count(*) from consents), 1::bigint, 'B sees own consent');
select is((select count(*) from enquiries), 1::bigint, 'B sees own enquiry');
select is((select count(*) from appointments), 1::bigint, 'B sees own appointment');
select is((select count(*) from sop_templates), 1::bigint, 'B sees own template');
select is((select count(*) from sop_steps), 1::bigint, 'B sees own SOP step');
select is((select count(*) from patient_treatments), 1::bigint, 'B sees own treatment');
select is((select count(*) from treatment_steps), 1::bigint, 'B sees own treatment step');
select is((select count(*) from documents), 1::bigint, 'B sees own document');
select is((select count(*) from payments), 1::bigint, 'B sees own payment');
select ok((select count(*) from audit_log) > 0, 'owner B can read own audit log');
select is((select count(*) from clinics), 1::bigint, 'B sees only own clinic');

reset role;
select * from finish();
rollback;
