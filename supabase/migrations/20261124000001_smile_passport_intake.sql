-- Smile Passport intake (journey v1, 28 Jun 2026):
-- public photo scan -> orthodontist review within 24h -> report -> consultation.
-- Also adds private file storage, which every upload feature needs.
-- No Smile Score and no AI: the doc says to review manually first and learn which metrics matter.

-- ---------- Clinic settings used by routing and the landing page ----------
alter table clinics add column home_cities text[] not null default '{}';  -- e.g. {vizag,visakhapatnam}
alter table clinics add column booking_url text;                          -- home-clinic booking link
alter table clinics add column review_fee_inr int not null default 0 check (review_fee_inr >= 0);

create policy clinic_owner_update on clinics for update
  using (my_role(id) = 'owner') with check (my_role(id) = 'owner');

-- ---------- Private file storage ----------
-- Files live under <clinic_id>/..., so the first path segment decides who may read them.
create or replace function storage_clinic(p_name text) returns uuid
language plpgsql immutable as $$
begin
  return split_part(p_name, '/', 1)::uuid;
exception when others then
  return null;
end $$;

insert into storage.buckets (id, name, public)
values ('clinic-files', 'clinic-files', false)
on conflict (id) do nothing;

create policy clinic_files_read on storage.objects for select to authenticated
  using (bucket_id = 'clinic-files'
         and my_role(storage_clinic(name)) in ('owner','doctor','coordinator'));
create policy clinic_files_write on storage.objects for insert to authenticated
  with check (bucket_id = 'clinic-files'
              and my_role(storage_clinic(name)) in ('owner','doctor','coordinator'));
create policy clinic_files_delete on storage.objects for delete to authenticated
  using (bucket_id = 'clinic-files' and my_role(storage_clinic(name)) in ('owner','doctor'));
-- Same 2FA rule as the tables, limited to this bucket so other buckets are untouched.
create policy clinic_files_mfa on storage.objects as restrictive for all to authenticated
  using (bucket_id <> 'clinic-files' or (select mfa_ok()))
  with check (bucket_id <> 'clinic-files' or (select mfa_ok()));

-- ---------- Referral partners (patients outside the home city) ----------
create table referral_partners (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  name text not null,
  city text,
  country text,
  phone text,
  notes text,
  active boolean not null default true,
  unique (id, clinic_id)
);

-- ---------- Scans ----------
create table smile_scans (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  patient_id uuid,
  full_name text not null,
  phone text not null,
  email text,
  city text not null,
  country text not null default 'India',
  main_concern text,
  source text,                                    -- utm_source or similar, if present
  consent_data boolean not null check (consent_data),  -- no scan without data-processing consent
  consent_whatsapp boolean not null default false,
  consent_text_version text not null,
  submitted_at timestamptz not null default now(),
  review_due_at timestamptz not null,
  status text not null default 'submitted' check (status in
    ('submitted','in_review','needs_better_photos','report_ready','report_sent',
     'consult_booked','treatment_started','closed')),
  route text not null check (route in ('home_clinic','referral')),
  referral_partner_id uuid,
  reviewer_id uuid references auth.users(id),
  report_observations text,
  report_areas text,
  report_options text,
  report_duration text,
  report_next_steps text,
  report_ready_at timestamptz,
  report_sent_at timestamptz,
  consult_booked_at timestamptz,
  treatment_started_at timestamptz,
  fee_inr int not null default 0,
  payment_status text not null default 'not_required'
    check (payment_status in ('not_required','pending','paid')),
  unique (id, clinic_id),
  foreign key (patient_id, clinic_id) references patients (id, clinic_id),
  foreign key (referral_partner_id, clinic_id) references referral_partners (id, clinic_id)
);
create index on smile_scans (clinic_id, status, review_due_at);
create index on smile_scans (clinic_id, submitted_at);

create table smile_scan_photos (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  scan_id uuid not null,
  kind text not null check (kind in ('front_smile','front_teeth','side_profile')),
  storage_path text not null,
  content_type text not null,
  bytes int not null,
  created_at timestamptz not null default now(),
  unique (scan_id, kind),
  foreign key (scan_id, clinic_id) references smile_scans (id, clinic_id) on delete cascade
);

-- Route by city and start the 24h review clock, in the database so every entry path agrees.
create or replace function smile_scans_defaults() returns trigger
language plpgsql as $$
declare v_fee int; v_home boolean;
begin
  select c.review_fee_inr,
         lower(trim(new.city)) = any (select lower(trim(x)) from unnest(c.home_cities) x)
    into v_fee, v_home
    from clinics c where c.id = new.clinic_id;
  new.route := case when coalesce(v_home, false) then 'home_clinic' else 'referral' end;
  new.review_due_at := new.submitted_at + interval '24 hours';
  new.fee_inr := coalesce(v_fee, 0);
  new.payment_status := case when coalesce(v_fee, 0) > 0 then 'pending' else 'not_required' end;
  return new;
end $$;
create trigger smile_scans_defaults before insert on smile_scans
  for each row execute function smile_scans_defaults();

-- Only owner or doctor can write the clinical report; nobody can rewrite consent or timestamps.
create or replace function smile_scans_guard() returns trigger
language plpgsql as $$
begin
  if new.clinic_id <> old.clinic_id or new.submitted_at <> old.submitted_at
     or new.consent_data <> old.consent_data or new.consent_text_version <> old.consent_text_version then
    raise exception 'scan identity and consent cannot change';
  end if;
  if auth.uid() is not null
     and (new.report_observations, new.report_areas, new.report_options, new.report_duration, new.report_next_steps)
         is distinct from
         (old.report_observations, old.report_areas, old.report_options, old.report_duration, old.report_next_steps)
     and coalesce(my_role(new.clinic_id), '') not in ('owner','doctor') then
    raise exception 'only a doctor can write the report' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger smile_scans_guard before update on smile_scans
  for each row execute function smile_scans_guard();

-- ---------- Review workflow ----------
create or replace function claim_scan(p_scan uuid) returns void
language plpgsql as $$
declare v smile_scans;
begin
  select * into v from smile_scans where id = p_scan;
  if not found then raise exception 'scan not found'; end if;
  if coalesce(my_role(v.clinic_id), '') not in ('owner','doctor') then
    raise exception 'only a doctor can review a scan' using errcode = '42501';
  end if;
  if v.status not in ('submitted','needs_better_photos') then
    raise exception 'scan is already %', v.status;
  end if;
  update smile_scans set status = 'in_review', reviewer_id = auth.uid() where id = p_scan;
end $$;

-- Picks who gets follow-up tasks: a coordinator first, then the owner.
create or replace function scan_task_owner(p_clinic uuid) returns uuid
language sql stable as $$
  select user_id from clinic_members
   where clinic_id = p_clinic and active and role in ('coordinator','owner')
   order by (role = 'coordinator') desc limit 1
$$;

create or replace function request_better_photos(p_scan uuid, p_note text) returns void
language plpgsql as $$
declare v smile_scans;
begin
  select * into v from smile_scans where id = p_scan;
  if not found then raise exception 'scan not found'; end if;
  if v.status not in ('submitted','in_review') then raise exception 'scan is already %', v.status; end if;
  if coalesce(trim(p_note), '') = '' then raise exception 'say what is wrong with the photos'; end if;
  update smile_scans set status = 'needs_better_photos' where id = p_scan;
  insert into tasks (clinic_id, assignee_id, title, due_at, source, created_by)
  values (v.clinic_id, scan_task_owner(v.clinic_id),
          'Ask ' || v.full_name || ' for clearer photos: ' || trim(p_note), now(), 'system', auth.uid());
end $$;

create or replace function save_report(
  p_scan uuid, p_observations text, p_areas text, p_options text, p_duration text, p_next_steps text
) returns void
language plpgsql as $$
declare v smile_scans;
begin
  select * into v from smile_scans where id = p_scan;
  if not found then raise exception 'scan not found'; end if;
  if v.status not in ('in_review','report_ready') then
    raise exception 'claim the scan before writing its report';
  end if;
  if coalesce(trim(p_observations), '') = '' or coalesce(trim(p_next_steps), '') = '' then
    raise exception 'observations and next steps are required';
  end if;
  update smile_scans set
    report_observations = trim(p_observations), report_areas = nullif(trim(p_areas), ''),
    report_options = nullif(trim(p_options), ''), report_duration = nullif(trim(p_duration), ''),
    report_next_steps = trim(p_next_steps), status = 'report_ready', report_ready_at = now()
  where id = p_scan;
  if not found then raise exception 'not permitted to write this report' using errcode = '42501'; end if;
end $$;

-- Staff share the report themselves (email or WhatsApp) and then mark it sent; a follow-up task is created.
create or replace function mark_report_sent(p_scan uuid) returns void
language plpgsql as $$
declare v smile_scans;
begin
  select * into v from smile_scans where id = p_scan;
  if not found then raise exception 'scan not found'; end if;
  if v.status <> 'report_ready' then raise exception 'write the report first'; end if;
  update smile_scans set status = 'report_sent', report_sent_at = now() where id = p_scan;
  insert into tasks (clinic_id, assignee_id, title, due_at, source, created_by)
  values (v.clinic_id, scan_task_owner(v.clinic_id),
          'Follow up with ' || v.full_name || ' about their Smile Report',
          now() + interval '2 days', 'system', auth.uid());
end $$;

create or replace function mark_consult_booked(p_scan uuid) returns void
language plpgsql as $$
begin
  update smile_scans set status = 'consult_booked', consult_booked_at = now()
   where id = p_scan and status = 'report_sent';
  if not found then raise exception 'send the report before marking a consultation booked'; end if;
end $$;

create or replace function mark_treatment_started(p_scan uuid) returns void
language plpgsql as $$
begin
  update smile_scans set status = 'treatment_started', treatment_started_at = now()
   where id = p_scan and status = 'consult_booked';
  if not found then raise exception 'a consultation must be booked first'; end if;
end $$;

create or replace function set_scan_payment(p_scan uuid, p_status text) returns void
language plpgsql as $$
begin
  if p_status not in ('pending','paid') then raise exception 'invalid payment status'; end if;
  update smile_scans set payment_status = p_status where id = p_scan and fee_inr > 0;
  if not found then raise exception 'this scan has no review fee'; end if;
end $$;

create or replace function assign_partner(p_scan uuid, p_partner uuid) returns void
language plpgsql as $$
begin
  update smile_scans set referral_partner_id = p_partner where id = p_scan and route = 'referral';
  if not found then raise exception 'only referral scans take a partner'; end if;
end $$;

-- Links the scan to a patient record (reusing one with the same phone) and carries consent over.
create or replace function convert_scan_to_patient(p_scan uuid) returns uuid
language plpgsql as $$
declare s smile_scans; v_patient uuid;
begin
  select * into s from smile_scans where id = p_scan;
  if not found then raise exception 'scan not found'; end if;
  if s.patient_id is not null then return s.patient_id; end if;

  select id into v_patient from patients
   where clinic_id = s.clinic_id and deleted_at is null
     and right(regexp_replace(phone, '\D', '', 'g'), 10) = right(regexp_replace(s.phone, '\D', '', 'g'), 10)
   limit 1;

  if v_patient is null then
    insert into patients (clinic_id, full_name, phone, email, lead_source)
    values (s.clinic_id, s.full_name, s.phone, s.email, 'website')
    returning id into v_patient;
    insert into consents (clinic_id, patient_id, kind, text_version, given_by)
    values (s.clinic_id, v_patient, 'data_processing', s.consent_text_version, s.full_name);
    if s.consent_whatsapp then
      insert into whatsapp_opt_events (clinic_id, patient_id, event, source, captured_by)
      values (s.clinic_id, v_patient, 'opt_in', 'smile_scan', auth.uid());
    end if;
  end if;

  update smile_scans set patient_id = v_patient where id = p_scan;
  return v_patient;
end $$;

-- ---------- Funnel numbers ----------
create table funnel_daily (
  clinic_id uuid not null references clinics(id) on delete cascade,
  day date not null,
  visits int not null default 0,
  primary key (clinic_id, day)
);

-- Called by the landing page with the service role. Counts page loads, no personal data stored.
create or replace function record_visit(p_clinic uuid) returns void
language sql security definer set search_path = public as $$
  insert into funnel_daily (clinic_id, day, visits)
  values (p_clinic, (now() at time zone 'Asia/Kolkata')::date, 1)
  on conflict (clinic_id, day) do update set visits = funnel_daily.visits + 1
$$;
revoke execute on function record_visit(uuid) from public, anon, authenticated;
grant execute on function record_visit(uuid) to service_role;

-- Cohort view: of the scans submitted in the range, how far did each get.
create or replace function smile_funnel(p_from date, p_to date)
returns table (visits bigint, scans bigint, reviews_delivered bigint,
               consults_booked bigint, treatments_started bigint)
language sql stable as $$
  select
    (select coalesce(sum(f.visits), 0) from funnel_daily f where f.day between p_from and p_to),
    count(*),
    count(*) filter (where s.report_sent_at is not null),
    count(*) filter (where s.consult_booked_at is not null),
    count(*) filter (where s.treatment_started_at is not null)
  from smile_scans s join clinics c on c.id = s.clinic_id
  where (s.submitted_at at time zone c.timezone)::date between p_from and p_to
$$;

-- ---------- Today queue gains pending scan reviews ----------
create or replace view today_queue with (security_invoker = true) as
select t.clinic_id, 'task'::text as kind, t.id as ref_id, t.patient_id, t.title,
       t.due_at, t.assignee_id
  from tasks t join clinics c on c.id = t.clinic_id
 where t.status = 'open'
   and (t.due_at is null
        or t.due_at < ((date_trunc('day', now() at time zone c.timezone) + interval '1 day') at time zone c.timezone))
union all
select ds.clinic_id, 'overdue_step', ds.step_id, ds.patient_id, ds.name, ds.due_at, null::uuid
  from delayed_steps ds
union all
select e.clinic_id, 'enquiry_unreplied', e.id, e.patient_id, 'Reply to ' || e.name,
       e.received_at + make_interval(mins => c.reply_sla_minutes), e.owner_id
  from enquiries e join clinics c on c.id = e.clinic_id
 where e.first_replied_at is null and e.status <> 'lost'
   and e.received_at + make_interval(mins => c.reply_sla_minutes) < now()
union all
select s.clinic_id, 'scan_review', s.id, s.patient_id, 'Review Smile Passport scan: ' || s.full_name,
       s.review_due_at, s.reviewer_id
  from smile_scans s where s.status in ('submitted','in_review');

-- ---------- RLS, 2FA, audit ----------
do $$
declare t text;
begin
  foreach t in array array['referral_partners','smile_scans','smile_scan_photos','funnel_daily'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy mfa_required on %I as restrictive for all to authenticated
                    using ((select mfa_ok())) with check ((select mfa_ok()))', t);
  end loop;
end $$;
create trigger audit_smile_scans after insert or update or delete on smile_scans
  for each row execute function audit_row();

-- Scans hold photos and clinical opinions: front desk never sees them. The public form
-- inserts with the service role, so there is no staff insert policy.
create policy scans_read on smile_scans for select
  using (my_role(clinic_id) in ('owner','doctor','coordinator'));
create policy scans_update on smile_scans for update
  using (my_role(clinic_id) in ('owner','doctor','coordinator'))
  with check (my_role(clinic_id) in ('owner','doctor','coordinator'));
create policy scan_photos_read on smile_scan_photos for select
  using (my_role(clinic_id) in ('owner','doctor','coordinator'));
create policy partners_read on referral_partners for select
  using (my_role(clinic_id) in ('owner','doctor','coordinator'));
create policy partners_write on referral_partners for all
  using (my_role(clinic_id) in ('owner','coordinator'))
  with check (my_role(clinic_id) in ('owner','coordinator'));
create policy funnel_read on funnel_daily for select
  using (my_role(clinic_id) in ('owner','coordinator'));
