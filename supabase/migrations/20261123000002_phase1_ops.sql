-- Phase 1 operations schema (roadmap v3 features #7, #8, #11 to #14):
-- patient profile extras, scheduling functions, enquiry funnel, task queue,
-- WhatsApp reminder queue gated by opt-in, and the Today queue view.

-- ---------- Staff display names ----------
alter table clinic_members add column display_name text;

-- ---------- #7 Patient database ----------
alter table patients add column preferred_language text not null default 'en';

-- Minors need a guardian. A trigger, not a CHECK, because "18 years ago" depends on today's date.
create or replace function patients_minor_guard() returns trigger
language plpgsql as $$
begin
  if new.dob is not null and new.dob > (current_date - interval '18 years')::date
     and coalesce(trim(new.guardian_name), '') = '' then
    raise exception 'a guardian name is required for patients under 18';
  end if;
  return new;
end $$;
create trigger patients_minor_guard before insert or update of dob, guardian_name on patients
  for each row execute function patients_minor_guard();

create index patients_phone10_idx on patients (clinic_id, right(regexp_replace(phone, '\D', '', 'g'), 10));

create or replace function find_duplicate_patients(p_phone text)
returns table (id uuid, full_name text)
language sql stable as $$
  select p.id, p.full_name from patients p
   where p.deleted_at is null
     and right(regexp_replace(p.phone, '\D', '', 'g'), 10) = right(regexp_replace(p_phone, '\D', '', 'g'), 10)
$$;

-- ---------- #8 Appointment scheduling (time zone handled in the database) ----------
create or replace function book_appointment(
  p_patient uuid, p_doctor uuid, p_chair text, p_day date, p_time time,
  p_minutes int, p_visit_type text
) returns uuid
language plpgsql as $$
declare v_clinic uuid; v_tz text; v_start timestamptz; v_id uuid;
begin
  select p.clinic_id, c.timezone into v_clinic, v_tz
    from patients p join clinics c on c.id = p.clinic_id where p.id = p_patient;
  if v_clinic is null then raise exception 'patient not found'; end if;
  if p_minutes is null or p_minutes < 5 or p_minutes > 480 then
    raise exception 'duration must be between 5 and 480 minutes';
  end if;
  v_start := (p_day + p_time) at time zone v_tz;
  insert into appointments (clinic_id, patient_id, doctor_id, chair, starts_at, ends_at, visit_type)
  values (v_clinic, p_patient, p_doctor, nullif(trim(p_chair), ''), v_start,
          v_start + make_interval(mins => p_minutes), p_visit_type)
  returning id into v_id;
  return v_id;
end $$;

create or replace function reschedule_appointment(p_id uuid, p_day date, p_time time)
returns void
language plpgsql as $$
declare v appointments; v_tz text; v_start timestamptz;
begin
  select * into v from appointments where id = p_id;
  if not found then raise exception 'appointment not found'; end if;
  if v.status <> 'booked' then raise exception 'only a booked appointment can be rescheduled'; end if;
  select timezone into v_tz from clinics where id = v.clinic_id;
  v_start := (p_day + p_time) at time zone v_tz;
  update appointments set starts_at = v_start, ends_at = v_start + (v.ends_at - v.starts_at)
   where id = p_id;
end $$;

create or replace function set_appointment_status(p_id uuid, p_status text) returns void
language plpgsql as $$
declare v_old text;
begin
  select status into v_old from appointments where id = p_id;
  if v_old is null then raise exception 'appointment not found'; end if;
  if not ((v_old = 'booked'  and p_status in ('arrived','cancelled','no_show'))
       or (v_old = 'arrived' and p_status in ('completed','cancelled'))) then
    raise exception 'cannot move an appointment from % to %', v_old, p_status;
  end if;
  update appointments set status = p_status where id = p_id;
end $$;

create or replace function appointments_for_day(p_day date)
returns table (id uuid, patient_id uuid, patient_name text, doctor_id uuid, chair text,
               starts_at timestamptz, ends_at timestamptz, status text, visit_type text)
language sql stable as $$
  select a.id, a.patient_id, p.full_name, a.doctor_id, a.chair,
         a.starts_at, a.ends_at, a.status, a.visit_type
    from appointments a
    join patients p on p.id = a.patient_id and p.clinic_id = a.clinic_id
    join clinics c on c.id = a.clinic_id
   where a.starts_at >= (p_day::timestamp at time zone c.timezone)
     and a.starts_at <  ((p_day + 1)::timestamp at time zone c.timezone)
   order by a.starts_at
$$;

-- ---------- #13 Enquiry funnel ----------
alter table enquiries add column channel text not null default 'whatsapp'
  check (channel in ('whatsapp','call','walk_in','web_form'));

-- Stamps a funnel stage once (never overwrites the first time) and only moves status forward.
create or replace function advance_enquiry(
  p_enquiry uuid, p_stage text, p_at timestamptz default now(), p_reason text default null
) returns void
language plpgsql as $$
declare
  v enquiries;
  v_order text[] := array['new','contacted','consult_booked','consult_attended',
                          'plan_offered','case_started','case_completed'];
  v_new_status text;
begin
  select * into v from enquiries where id = p_enquiry;
  if not found then raise exception 'enquiry not found'; end if;

  v_new_status := case p_stage
    when 'first_reply' then 'contacted' when 'consult_booked' then 'consult_booked'
    when 'consult_attended' then 'consult_attended' when 'plan_offered' then 'plan_offered'
    when 'case_started' then 'case_started' when 'case_completed' then 'case_completed'
    when 'lost' then 'lost' end;
  if v_new_status is null then raise exception 'unknown stage %', p_stage; end if;
  if p_stage = 'lost' and coalesce(trim(p_reason), '') = '' then
    raise exception 'a reason is required when an enquiry is lost';
  end if;

  update enquiries set
    first_replied_at   = case when p_stage = 'first_reply'      then coalesce(first_replied_at, p_at)   else first_replied_at end,
    consult_booked_at  = case when p_stage = 'consult_booked'   then coalesce(consult_booked_at, p_at)  else consult_booked_at end,
    consult_attended_at= case when p_stage = 'consult_attended' then coalesce(consult_attended_at, p_at) else consult_attended_at end,
    plan_offered_at    = case when p_stage = 'plan_offered'     then coalesce(plan_offered_at, p_at)    else plan_offered_at end,
    case_started_at    = case when p_stage = 'case_started'     then coalesce(case_started_at, p_at)    else case_started_at end,
    case_completed_at  = case when p_stage = 'case_completed'   then coalesce(case_completed_at, p_at)  else case_completed_at end,
    lost_reason        = case when p_stage = 'lost' then trim(p_reason) else lost_reason end,
    status = case
      when p_stage = 'lost' then 'lost'
      when array_position(v_order, v_new_status) > coalesce(array_position(v_order, status), 0) then v_new_status
      else status end
  where id = p_enquiry;
  if not found then raise exception 'not permitted to change this enquiry' using errcode = '42501'; end if;
end $$;

-- ---------- #14 Staff task queue ----------
create table tasks (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  assignee_id uuid references auth.users(id),
  patient_id uuid,
  title text not null,
  due_at timestamptz,
  status text not null default 'open' check (status in ('open','done','cancelled')),
  outcome text,
  source text not null default 'manual' check (source in ('manual','system')),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  foreign key (patient_id, clinic_id) references patients (id, clinic_id)
);
create index on tasks (clinic_id, assignee_id, status, due_at);

create or replace function tasks_guard() returns trigger
language plpgsql as $$
begin
  if new.assignee_id is not null and not exists (
    select 1 from clinic_members where clinic_id = new.clinic_id and user_id = new.assignee_id and active
  ) then
    raise exception 'assignee is not an active member of this clinic';
  end if;
  return new;
end $$;
create trigger tasks_guard before insert or update of assignee_id on tasks
  for each row execute function tasks_guard();

create or replace function complete_task(p_task uuid, p_outcome text) returns void
language plpgsql as $$
begin
  if coalesce(trim(p_outcome), '') = '' then raise exception 'an outcome is required'; end if;
  update tasks set status = 'done', outcome = trim(p_outcome), completed_at = now()
   where id = p_task and status = 'open';
  if not found then raise exception 'task not found, already closed, or not permitted'; end if;
end $$;

-- ---------- #11 and #12 WhatsApp: templates, outbound queue, inbound log ----------
create table message_templates (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  key text not null,                       -- appointment_reminder, ...
  language text not null,
  provider_template_name text,             -- name approved by the WhatsApp provider
  body text not null,
  approved boolean not null default false, -- only approved templates are ever queued
  unique (clinic_id, key, language),
  unique (id, clinic_id)
);

create table outbound_messages (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  patient_id uuid not null,
  appointment_id uuid,
  template_id uuid,
  kind text not null,
  status text not null default 'queued'
    check (status in ('queued','sent','delivered','read','failed','blocked_no_opt_in')),
  scheduled_for timestamptz not null default now(),
  provider_message_id text,
  error text,
  sent_at timestamptz,
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (patient_id, clinic_id) references patients (id, clinic_id),
  foreign key (appointment_id, clinic_id) references appointments (id, clinic_id),
  foreign key (template_id, clinic_id) references message_templates (id, clinic_id),
  unique (appointment_id, kind)            -- enqueueing twice is harmless
);
create index on outbound_messages (status, scheduled_for);

create table inbound_messages (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  patient_id uuid,
  from_phone text not null,
  body text not null,
  provider_message_id text,
  received_at timestamptz not null default now(),
  foreign key (patient_id, clinic_id) references patients (id, clinic_id)
);

-- No message to a patient without a valid opt-in, checked when queued AND when marked sent.
create or replace function outbound_opt_in_gate() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_opt boolean;
begin
  if tg_op = 'INSERT' or (new.status = 'sent' and old.status is distinct from 'sent') then
    select whatsapp_opt_in into v_opt from patients
     where id = new.patient_id and clinic_id = new.clinic_id;
    if not coalesce(v_opt, false) then
      if tg_op = 'INSERT' then
        raise exception 'patient has not opted in to WhatsApp';
      end if;
      new.status := 'blocked_no_opt_in';
    end if;
  end if;
  return new;
end $$;
create trigger outbound_opt_in_gate before insert or update on outbound_messages
  for each row execute function outbound_opt_in_gate();

-- An opt-out takes effect immediately: queued messages for that patient are blocked.
create or replace function sync_whatsapp_opt() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update patients set whatsapp_opt_in = (new.event = 'opt_in')
   where id = new.patient_id and clinic_id = new.clinic_id;
  if new.event = 'opt_out' then
    update outbound_messages set status = 'blocked_no_opt_in'
     where patient_id = new.patient_id and clinic_id = new.clinic_id and status = 'queued';
  end if;
  return new;
end $$;

-- Run on a schedule by the worker (service role). Only opted-in patients with an approved
-- template in their language get a reminder. Safe to run repeatedly.
create or replace function enqueue_appointment_reminders(p_ahead interval default interval '24 hours')
returns int
language plpgsql as $$
declare n int;
begin
  insert into outbound_messages (clinic_id, patient_id, appointment_id, template_id, kind, scheduled_for)
  select a.clinic_id, a.patient_id, a.id, t.id, 'appointment_reminder',
         greatest(now(), a.starts_at - p_ahead)
    from appointments a
    join patients p on p.id = a.patient_id and p.clinic_id = a.clinic_id
                   and p.whatsapp_opt_in and p.deleted_at is null
    join message_templates t on t.clinic_id = a.clinic_id and t.key = 'appointment_reminder'
                            and t.language = p.preferred_language and t.approved
   where a.status = 'booked' and a.starts_at > now() and a.starts_at <= now() + p_ahead + interval '1 hour'
  on conflict (appointment_id, kind) do nothing;
  get diagnostics n = row_count;
  return n;
end $$;
revoke execute on function enqueue_appointment_reminders(interval) from public, anon, authenticated;

-- ---------- Today queue ----------
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
   and e.received_at + make_interval(mins => c.reply_sla_minutes) < now();

-- ---------- Audit, RLS, role matrix ----------
do $$
declare t text;
begin
  foreach t in array array['tasks','message_templates','outbound_messages','inbound_messages'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy mfa_required on %I as restrictive for all to authenticated
                    using ((select mfa_ok())) with check ((select mfa_ok()))', t);
  end loop;
  foreach t in array array['tasks','message_templates'] loop
    execute format('create trigger audit_%1$s after insert or update or delete on %1$s
                    for each row execute function audit_row()', t);
  end loop;
end $$;

-- Tasks: you see your own; owner and coordinator see everyone's. Anyone can create. No deletes (cancel instead).
create policy tasks_select on tasks for select using (
  clinic_id in (select my_clinic_ids())
  and (assignee_id = auth.uid() or my_role(clinic_id) in ('owner','coordinator')));
create policy tasks_insert on tasks for insert with check (clinic_id in (select my_clinic_ids()));
create policy tasks_update on tasks for update
  using (clinic_id in (select my_clinic_ids())
         and (assignee_id = auth.uid() or my_role(clinic_id) in ('owner','coordinator')))
  with check (clinic_id in (select my_clinic_ids()));

-- Templates: all staff read, owner and coordinator write. Outbound and inbound: staff read; only the server writes.
create policy templates_read on message_templates for select using (clinic_id in (select my_clinic_ids()));
create policy templates_write on message_templates for all
  using (my_role(clinic_id) in ('owner','coordinator'))
  with check (my_role(clinic_id) in ('owner','coordinator'));
create policy outbound_read on outbound_messages for select using (clinic_id in (select my_clinic_ids()));
create policy inbound_read on inbound_messages for select
  using (my_role(clinic_id) in ('owner','coordinator','front_desk'));
