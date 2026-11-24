-- Phase 0 extensions (roadmap v3, features #2 to #5):
-- data model for notes, tooth chart, lab orders, invoices, WhatsApp opt-in events,
-- AI action records, updated_at trigger, and role-specific access.
-- DRAFT: role matrix and GST invoice fields need confirmation (see README).

-- ---------- updated_at ----------
create or replace function set_updated_at() returns trigger
language plpgsql as $$ begin new.updated_at = now(); return new; end $$;

create trigger patients_updated_at before update on patients
  for each row execute function set_updated_at();

-- ---------- Medical details move to a clinical-only table ----------
create table patient_medical (
  patient_id uuid primary key references patients(id) on delete cascade,
  clinic_id uuid not null references clinics(id) on delete cascade,
  medical_history jsonb not null default '{}',
  allergies text[] not null default '{}',
  updated_at timestamptz not null default now()
);
insert into patient_medical (patient_id, clinic_id, medical_history, allergies)
  select id, clinic_id, medical_history, allergies from patients;
alter table patients drop column medical_history, drop column allergies;
create trigger patient_medical_updated_at before update on patient_medical
  for each row execute function set_updated_at();

-- ---------- Clinical records ----------
create table visit_notes (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  patient_id uuid not null references patients(id),
  appointment_id uuid references appointments(id),
  author_id uuid references auth.users(id),
  body text not null,
  created_at timestamptz not null default now()
);

create table tooth_chart_entries (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  patient_id uuid not null references patients(id),
  appointment_id uuid references appointments(id),
  tooth text not null,            -- notation (FDI or other) to be confirmed with the doctor
  condition text not null,
  note text,
  recorded_by uuid references auth.users(id),
  recorded_at timestamptz not null default now()
);

create table lab_orders (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  patient_id uuid not null references patients(id),
  treatment_step_id uuid references treatment_steps(id),   -- the step this order holds up
  vendor text not null,
  item text not null,
  status text not null default 'ordered' check (status in ('ordered','delivered','cancelled')),
  ordered_at timestamptz not null default now(),
  expected_at timestamptz,
  delivered_at timestamptz
);

-- ---------- Invoices (GST format and applicability: confirm with the accountant) ----------
create table invoices (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  patient_id uuid not null references patients(id),
  payment_id uuid references payments(id),
  number text not null,
  issued_at timestamptz not null default now(),
  amount_paise bigint not null,
  tax_paise bigint not null default 0,
  status text not null default 'issued' check (status in ('draft','issued','cancelled')),
  unique (clinic_id, number)
);

-- ---------- WhatsApp opt-in and opt-out (append-only) ----------
create table whatsapp_opt_events (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  patient_id uuid not null references patients(id),
  event text not null check (event in ('opt_in','opt_out')),
  source text not null,           -- registration, enquiry, whatsapp_stop, staff
  captured_by uuid references auth.users(id),
  at timestamptz not null default now()
);

create or replace function sync_whatsapp_opt() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update patients set whatsapp_opt_in = (new.event = 'opt_in') where id = new.patient_id;
  return new;
end $$;
create trigger whatsapp_opt_sync after insert on whatsapp_opt_events
  for each row execute function sync_whatsapp_opt();

-- ---------- AI action records (written by the server with the service role) ----------
create table ai_actions (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  feature text not null,          -- enquiry_reply, checkin_classification, ...
  patient_id uuid references patients(id),
  input_ref jsonb not null default '{}',   -- references to records, not copies of patient data
  draft text,
  model text,
  reviewer_id uuid references auth.users(id),
  final_text text,
  outcome text not null default 'pending'
    check (outcome in ('pending','sent','edited_sent','discarded')),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz
);

-- ---------- Audit triggers and RLS for the new tables ----------
do $$
declare t text;
begin
  foreach t in array array[
    'patient_medical','visit_notes','tooth_chart_entries','lab_orders','invoices',
    'whatsapp_opt_events','ai_actions'
  ] loop
    execute format('create trigger audit_%1$s after insert or update or delete on %1$s
                    for each row execute function audit_row()', t);
    execute format('alter table %I enable row level security', t);
  end loop;
end $$;

-- ---------- Role matrix ----------
-- clinical: owner, doctor write; coordinator reads. Front desk: no access.
do $$
declare t text;
begin
  foreach t in array array['patient_medical','visit_notes','tooth_chart_entries'] loop
    execute format('create policy clinical_write on %I for all
      using (my_role(clinic_id) in (''owner'',''doctor''))
      with check (my_role(clinic_id) in (''owner'',''doctor''))', t);
    execute format('create policy clinical_read on %I for select
      using (my_role(clinic_id) = ''coordinator'')', t);
  end loop;
end $$;

-- lab orders: owner, doctor, coordinator
create policy lab_rw on lab_orders for all
  using (my_role(clinic_id) in ('owner','doctor','coordinator'))
  with check (my_role(clinic_id) in ('owner','doctor','coordinator'));

-- finance: owner, coordinator write; doctor reads. Front desk: none (decision pending).
drop policy tenant_isolation on payments;
do $$
declare t text;
begin
  foreach t in array array['payments','invoices'] loop
    execute format('create policy finance_write on %I for all
      using (my_role(clinic_id) in (''owner'',''coordinator''))
      with check (my_role(clinic_id) in (''owner'',''coordinator''))', t);
    execute format('create policy finance_read on %I for select
      using (my_role(clinic_id) = ''doctor'')', t);
  end loop;
end $$;

-- opt-in events: any staff role can record and read; nobody can edit or delete
create policy opt_read on whatsapp_opt_events for select
  using (clinic_id in (select my_clinic_ids()));
create policy opt_insert on whatsapp_opt_events for insert
  with check (clinic_id in (select my_clinic_ids()));

-- AI actions: staff can read; only the server (service role) writes
create policy ai_read on ai_actions for select
  using (my_role(clinic_id) in ('owner','doctor','coordinator'));
