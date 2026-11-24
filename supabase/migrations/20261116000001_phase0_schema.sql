-- S-One Clinic OS: Phase 0 schema (Postgres / Supabase)
-- Multi-tenant: every table carries clinic_id, isolated by row-level security.
-- DRAFT: have a clinician and legal counsel review before real patient data.

create extension if not exists pgcrypto;

-- ---------- Tenancy and roles ----------
create table clinics (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  timezone text not null default 'Asia/Kolkata',
  reply_sla_minutes int not null default 120,
  settings jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table clinic_members (
  clinic_id uuid not null references clinics(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner','doctor','coordinator','front_desk')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (clinic_id, user_id)
);

create or replace function my_clinic_ids() returns setof uuid
language sql stable security definer set search_path = public as $$
  select clinic_id from clinic_members where user_id = auth.uid() and active
$$;

create or replace function my_role(p_clinic uuid) returns text
language sql stable security definer set search_path = public as $$
  select role from clinic_members
  where user_id = auth.uid() and clinic_id = p_clinic and active
$$;

-- ---------- Patients ----------
create type lead_source as enum (
  'google_search_maps','instagram','facebook_instagram_ad','whatsapp_click_to_chat',
  'patient_referral','doctor_referral','walk_in_signboard','website','other'
);

create table patients (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  full_name text not null,
  phone text not null,
  email text,
  dob date,
  sex text,
  address text,
  allergies text[] not null default '{}',
  medical_history jsonb not null default '{}',
  guardian_name text,          -- required in app logic for minors
  guardian_phone text,
  lead_source lead_source,
  referred_by_patient_id uuid references patients(id),
  referrer_note text,
  notes text,
  whatsapp_opt_in boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz       -- soft delete only
);
create index on patients (clinic_id, phone);   -- duplicate detection later
create index on patients (clinic_id, full_name);

create table consents (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  patient_id uuid not null references patients(id),
  kind text not null,          -- data_processing, whatsapp, treatment, photo_use
  text_version text not null,
  given_by text not null,      -- patient or guardian name
  given_at timestamptz not null default now(),
  withdrawn_at timestamptz
);

-- ---------- Enquiries and funnel (captured from day one) ----------
create table enquiries (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  patient_id uuid references patients(id),
  name text not null,
  phone text not null,
  lead_source lead_source not null,          -- required
  referrer_patient_id uuid references patients(id),
  referrer_note text,
  owner_id uuid references auth.users(id),
  status text not null default 'new',
  received_at timestamptz not null default now(),
  first_replied_at timestamptz,
  consult_booked_at timestamptz,
  consult_attended_at timestamptz,
  plan_offered_at timestamptz,
  case_started_at timestamptz,
  case_completed_at timestamptz,
  lost_reason text
);
create index on enquiries (clinic_id, received_at);

-- ---------- Appointments ----------
create table appointments (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  patient_id uuid not null references patients(id),
  doctor_id uuid references auth.users(id),
  chair text,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status text not null default 'booked'
    check (status in ('booked','arrived','completed','no_show','cancelled')),
  visit_type text not null check (visit_type in ('new','follow_up','walkin')),
  created_at timestamptz not null default now()
);
create index on appointments (clinic_id, starts_at);

-- ---------- SOPs (versioned) ----------
create table sop_templates (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  name text not null,
  version int not null default 1,
  status text not null default 'draft' check (status in ('draft','published','retired')),
  reviewed_by text,            -- clinician who signed off
  created_at timestamptz not null default now(),
  unique (clinic_id, name, version)
);

create table sop_steps (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  template_id uuid not null references sop_templates(id) on delete cascade,
  position int not null,
  name text not null,
  days_after_previous int not null default 0,   -- interval from ACTUAL completion of prior step
  unique (template_id, position)
);

-- ---------- Treatments and journey ----------
create table patient_treatments (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  patient_id uuid not null references patients(id),
  template_id uuid not null references sop_templates(id),  -- pins the version
  doctor_id uuid references auth.users(id),
  status text not null default 'active'
    check (status in ('planned','active','completed','dropped')),
  total_cost_paise bigint,
  started_at timestamptz,
  completed_at timestamptz
);

create table treatment_steps (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  patient_treatment_id uuid not null references patient_treatments(id) on delete cascade,
  sop_step_id uuid references sop_steps(id),
  position int not null,
  name text not null,
  status text not null default 'pending' check (status in ('pending','done','skipped')),
  due_at timestamptz,
  completed_at timestamptz,
  appointment_id uuid references appointments(id)
);
create index on treatment_steps (clinic_id, status, due_at);

-- ---------- Documents and payments ----------
create table documents (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  patient_id uuid not null references patients(id),
  appointment_id uuid references appointments(id),
  kind text not null,          -- photo, xray, consent_form, scan
  storage_path text not null,
  created_at timestamptz not null default now()
);

create table payments (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  patient_treatment_id uuid not null references patient_treatments(id),
  amount_paise bigint not null,
  due_date date not null,
  paid_at timestamptz,
  paid_amount_paise bigint
);

-- ---------- Audit trail ----------
create table audit_log (
  id bigserial primary key,
  clinic_id uuid,
  actor_id uuid,
  table_name text not null,
  row_id text,
  action text not null,        -- INSERT, UPDATE, DELETE
  old_data jsonb,
  new_data jsonb,
  at timestamptz not null default now()
);
create index on audit_log (clinic_id, at);

create or replace function audit_row() returns trigger
language plpgsql security definer set search_path = public as $$
declare j jsonb := to_jsonb(coalesce(new, old));
begin
  insert into audit_log (clinic_id, actor_id, table_name, row_id, action, old_data, new_data)
  values ((coalesce(j->>'clinic_id', j->>'id'))::uuid, auth.uid(), tg_table_name,
          j->>'id', tg_op,
          case when tg_op <> 'INSERT' then to_jsonb(old) end,
          case when tg_op <> 'DELETE' then to_jsonb(new) end);
  return coalesce(new, old);
end $$;

-- ---------- Triggers and RLS applied in one pass ----------
do $$
declare t text;
begin
  foreach t in array array[
    'patients','consents','enquiries','appointments','sop_templates','sop_steps',
    'patient_treatments','treatment_steps','documents','payments'
  ] loop
    execute format('create trigger audit_%1$s after insert or update or delete on %1$s
                    for each row execute function audit_row()', t);
    execute format('alter table %I enable row level security', t);
    execute format('create policy tenant_isolation on %I
                    using (clinic_id in (select my_clinic_ids()))
                    with check (clinic_id in (select my_clinic_ids()))', t);
  end loop;
end $$;

alter table clinics enable row level security;
create policy clinic_read on clinics for select using (id in (select my_clinic_ids()));

alter table clinic_members enable row level security;
create policy members_read on clinic_members for select
  using (clinic_id in (select my_clinic_ids()));

alter table audit_log enable row level security;
create policy audit_owner_read on audit_log for select using (my_role(clinic_id) = 'owner');
-- no insert/update/delete policies: only the security-definer trigger writes here

-- TODO next:
--  * role-specific policies (front desk: no payments or medical_history; doctor: clinical only)
--  * updated_at trigger on patients
--  * RLS tests: user in clinic A must read zero rows from clinic B, on every table
--  * storage bucket policies for documents, keyed by clinic_id path prefix
