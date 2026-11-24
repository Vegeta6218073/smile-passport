-- Hardening pass from the Phase 0 review (see docs/REVIEW.md for the findings).
-- 1 same-clinic reference integrity  2 opt-in sync scoping  3 MFA enforced in the database
-- 4 role matrix for treatments and SOPs  5 appointment rules  6 SOP versioning rules
-- 7 journey engine guards  8 enquiry status vocabulary

create extension if not exists btree_gist;

-- ---------- 1. Same-clinic reference integrity ----------
-- Before: patient_id etc. were plain FKs, so a row in clinic A could point at a patient in clinic B.
-- After: every cross-table reference is (id, clinic_id), so the pair must match.
alter table patients           add constraint patients_id_clinic_key           unique (id, clinic_id);
alter table appointments       add constraint appointments_id_clinic_key       unique (id, clinic_id);
alter table sop_templates      add constraint sop_templates_id_clinic_key      unique (id, clinic_id);
alter table sop_steps          add constraint sop_steps_id_clinic_key          unique (id, clinic_id);
alter table patient_treatments add constraint patient_treatments_id_clinic_key unique (id, clinic_id);
alter table treatment_steps    add constraint treatment_steps_id_clinic_key    unique (id, clinic_id);
alter table payments           add constraint payments_id_clinic_key           unique (id, clinic_id);

do $$
declare r record;
begin
  for r in select * from (values
    ('patients',            'referred_by_patient_id', 'patients',            'no action'),
    ('consents',            'patient_id',             'patients',            'no action'),
    ('enquiries',           'patient_id',             'patients',            'no action'),
    ('enquiries',           'referrer_patient_id',    'patients',            'no action'),
    ('appointments',        'patient_id',             'patients',            'no action'),
    ('sop_steps',           'template_id',            'sop_templates',       'cascade'),
    ('patient_treatments',  'patient_id',             'patients',            'no action'),
    ('patient_treatments',  'template_id',            'sop_templates',       'no action'),
    ('treatment_steps',     'patient_treatment_id',   'patient_treatments',  'cascade'),
    ('treatment_steps',     'sop_step_id',            'sop_steps',           'no action'),
    ('treatment_steps',     'appointment_id',         'appointments',        'no action'),
    ('documents',           'patient_id',             'patients',            'no action'),
    ('documents',           'appointment_id',         'appointments',        'no action'),
    ('payments',            'patient_treatment_id',   'patient_treatments',  'no action'),
    ('patient_medical',     'patient_id',             'patients',            'cascade'),
    ('visit_notes',         'patient_id',             'patients',            'no action'),
    ('visit_notes',         'appointment_id',         'appointments',        'no action'),
    ('tooth_chart_entries', 'patient_id',             'patients',            'no action'),
    ('tooth_chart_entries', 'appointment_id',         'appointments',        'no action'),
    ('lab_orders',          'patient_id',             'patients',            'no action'),
    ('lab_orders',          'treatment_step_id',      'treatment_steps',     'no action'),
    ('invoices',            'patient_id',             'patients',            'no action'),
    ('invoices',            'payment_id',             'payments',            'no action'),
    ('whatsapp_opt_events', 'patient_id',             'patients',            'no action'),
    ('ai_actions',          'patient_id',             'patients',            'no action')
  ) as v(tbl, col, ref, on_del) loop
    execute format('alter table %I drop constraint %I', r.tbl, r.tbl || '_' || r.col || '_fkey');
    execute format(
      'alter table %I add constraint %I foreign key (%I, clinic_id) references %I (id, clinic_id) on delete %s',
      r.tbl, r.tbl || '_' || r.col || '_same_clinic', r.col, r.ref, r.on_del);
  end loop;
end $$;

-- ---------- 2. Opt-in sync can only touch the event's own clinic ----------
-- Before: this SECURITY DEFINER function updated any patient id it was given.
create or replace function sync_whatsapp_opt() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update patients set whatsapp_opt_in = (new.event = 'opt_in')
   where id = new.patient_id and clinic_id = new.clinic_id;
  return new;
end $$;

-- ---------- 3. MFA enforced in the database ----------
-- Before: only the Next.js layout checked the 2FA level, so a signed-in password-only session
-- could call the API directly. A user with a verified factor now needs an aal2 session.
create or replace function mfa_ok() returns boolean
language sql stable security definer set search_path = public, auth as $$
  select coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2'
      or not exists (select 1 from auth.mfa_factors where user_id = auth.uid() and status = 'verified')
$$;

do $$
declare t text;
begin
  foreach t in array array[
    'clinics','clinic_members','audit_log','patients','consents','enquiries','appointments',
    'sop_templates','sop_steps','patient_treatments','treatment_steps','documents','payments',
    'patient_medical','visit_notes','tooth_chart_entries','lab_orders','invoices',
    'whatsapp_opt_events','ai_actions'
  ] loop
    execute format('create policy mfa_required on %I as restrictive for all to authenticated
                    using ((select mfa_ok())) with check ((select mfa_ok()))', t);
  end loop;
end $$;

-- ---------- 4. Role matrix for treatments and SOPs ----------
-- Before: front desk could complete treatment steps and edit SOPs.
-- Read: any staff. Write treatments: owner, doctor, coordinator. Write SOPs: owner, doctor.
drop policy tenant_isolation on patient_treatments;
drop policy tenant_isolation on treatment_steps;
drop policy tenant_isolation on sop_templates;
drop policy tenant_isolation on sop_steps;

do $$
declare t text;
begin
  foreach t in array array['patient_treatments','treatment_steps','sop_templates','sop_steps'] loop
    execute format('create policy staff_read on %I for select
      using (clinic_id in (select my_clinic_ids()))', t);
  end loop;
  foreach t in array array['patient_treatments','treatment_steps'] loop
    execute format('create policy clinical_write on %I for all
      using (my_role(clinic_id) in (''owner'',''doctor'',''coordinator''))
      with check (my_role(clinic_id) in (''owner'',''doctor'',''coordinator''))', t);
  end loop;
  foreach t in array array['sop_templates','sop_steps'] loop
    execute format('create policy sop_write on %I for all
      using (my_role(clinic_id) in (''owner'',''doctor''))
      with check (my_role(clinic_id) in (''owner'',''doctor''))', t);
  end loop;
end $$;

-- ---------- 5. Appointment rules ----------
alter table appointments drop constraint appointments_visit_type_check;
alter table appointments add constraint appointments_visit_type_check
  check (visit_type in ('new','follow_up','walkin','emergency'));
alter table appointments add constraint appointments_time_order check (ends_at > starts_at);
-- No double-booking a doctor or a chair. Adjacent slots are fine (ranges are [start, end)).
alter table appointments add constraint appointments_no_doctor_overlap
  exclude using gist (clinic_id with =, doctor_id with =, tstzrange(starts_at, ends_at) with &&)
  where (doctor_id is not null and status in ('booked','arrived'));
alter table appointments add constraint appointments_no_chair_overlap
  exclude using gist (clinic_id with =, chair with =, tstzrange(starts_at, ends_at) with &&)
  where (chair is not null and status in ('booked','arrived'));

-- ---------- 6. SOP versioning: published means frozen ----------
alter table sop_templates add constraint sop_published_needs_signoff
  check (status = 'draft' or reviewed_by is not null);

create or replace function sop_steps_guard() returns trigger
language plpgsql as $$
declare v_status text;
begin
  select status into v_status from sop_templates where id = coalesce(new.template_id, old.template_id);
  -- v_status is null when the template itself is being deleted (cascade): allow.
  if v_status is not null and v_status <> 'draft' then
    raise exception 'steps of a % SOP cannot change; create a new version', v_status;
  end if;
  return coalesce(new, old);
end $$;
create trigger sop_steps_guard before insert or update or delete on sop_steps
  for each row execute function sop_steps_guard();

create or replace function sop_template_guard() returns trigger
language plpgsql as $$
begin
  if old.status <> 'draft' and (new.name <> old.name or new.version <> old.version
       or new.reviewed_by is distinct from old.reviewed_by) then
    raise exception 'a % SOP cannot be edited; create a new version', old.status;
  end if;
  if old.status = 'retired' and new.status <> 'retired' then
    raise exception 'a retired SOP stays retired';
  end if;
  if old.status = 'published' and new.status = 'draft' then
    raise exception 'a published SOP cannot go back to draft';
  end if;
  return new;
end $$;
create trigger sop_template_guard before update on sop_templates
  for each row execute function sop_template_guard();

create or replace function publish_sop(p_template uuid, p_reviewed_by text) returns void
language plpgsql as $$
declare v sop_templates;
begin
  if coalesce(trim(p_reviewed_by), '') = '' then
    raise exception 'clinician sign-off is required to publish';
  end if;
  select * into v from sop_templates where id = p_template;
  if not found then raise exception 'template not found'; end if;
  if not exists (select 1 from sop_steps where template_id = p_template) then
    raise exception 'a SOP needs at least one step';
  end if;
  update sop_templates set status = 'published', reviewed_by = trim(p_reviewed_by)
   where id = p_template and status = 'draft';
  if not found then raise exception 'only a draft SOP can be published'; end if;
  -- Older published versions of the same SOP retire; running treatments keep their pinned version.
  update sop_templates set status = 'retired'
   where clinic_id = v.clinic_id and name = v.name and status = 'published' and id <> p_template;
end $$;

create or replace function new_sop_version(p_template uuid) returns uuid
language plpgsql as $$
declare v sop_templates; v_new uuid;
begin
  select * into v from sop_templates where id = p_template;
  if not found then raise exception 'template not found'; end if;
  insert into sop_templates (clinic_id, name, version, status)
  values (v.clinic_id, v.name,
          (select max(version) + 1 from sop_templates where clinic_id = v.clinic_id and name = v.name),
          'draft')
  returning id into v_new;
  insert into sop_steps (clinic_id, template_id, position, name, days_after_previous)
  select clinic_id, v_new, position, name, days_after_previous from sop_steps where template_id = p_template;
  return v_new;
end $$;

-- ---------- 7. Journey engine guards ----------
create or replace function start_treatment(
  p_patient uuid, p_template uuid, p_doctor uuid default null,
  p_started_at timestamptz default now()
) returns uuid
language plpgsql as $$
declare v_clinic uuid; v_status text; v_id uuid;
begin
  select clinic_id, status into v_clinic, v_status from sop_templates where id = p_template;
  if v_clinic is null then raise exception 'template not found'; end if;
  if v_status <> 'published' then raise exception 'only a published SOP can be started'; end if;

  -- The (patient_id, clinic_id) foreign key rejects a patient from another clinic.
  insert into patient_treatments (clinic_id, patient_id, template_id, doctor_id, status, started_at)
  values (v_clinic, p_patient, p_template, p_doctor, 'active', p_started_at)
  returning id into v_id;

  insert into treatment_steps (clinic_id, patient_treatment_id, sop_step_id, position, name)
  select v_clinic, v_id, id, position, name
    from sop_steps where template_id = p_template order by position;

  perform recompute_next_due(v_id);
  return v_id;
end $$;

-- Before: RLS could silently block the update and the call still "succeeded".
create or replace function advance_step(
  p_step uuid, p_status text, p_at timestamptz default now()
) returns void
language plpgsql as $$
declare v_treatment uuid; v_tstatus text; v_first_pending uuid;
begin
  if p_status not in ('done', 'skipped') then
    raise exception 'status must be done or skipped';
  end if;

  select ts.patient_treatment_id, pt.status into v_treatment, v_tstatus
    from treatment_steps ts join patient_treatments pt on pt.id = ts.patient_treatment_id
   where ts.id = p_step;
  if v_treatment is null then raise exception 'step not found'; end if;
  if v_tstatus <> 'active' then raise exception 'treatment is %, not active', v_tstatus; end if;

  select id into v_first_pending from treatment_steps
   where patient_treatment_id = v_treatment and status = 'pending'
   order by position limit 1;
  if v_first_pending is distinct from p_step then
    raise exception 'only the next pending step can be completed or skipped';
  end if;

  update treatment_steps
     set status = p_status, completed_at = case when p_status = 'done' then p_at end
   where id = p_step;
  if not found then
    raise exception 'not permitted to change this step' using errcode = '42501';
  end if;

  perform recompute_next_due(v_treatment);
end $$;

-- ---------- 8. Enquiry status vocabulary ----------
alter table enquiries add constraint enquiries_status_check check (status in
  ('new','contacted','consult_booked','consult_attended','plan_offered','case_started','case_completed','lost'));
