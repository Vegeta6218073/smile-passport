-- Phase 3: Clinical depth and retention (roadmap v3, features #28 to #41).
--  28 treatment plans and estimates        29 plan explainer (app side, through the AI gateway)
--  30 documents and clinical media         31 clinical notes and tooth charting
--  32 lab and vendor tracking              33 retention phase after debond
--  34 patient photos over WhatsApp         35 patient feedback
--  36 analytics (app side, owner_dashboard) 37 marketing source report
--  38 duplicate detection and merge        39 staff notifications
--  40 waitlist and cancellation fill       41 owner weekly summary (app side)

-- =====================================================================
-- 28. Treatment plans and estimates
-- =====================================================================
create table treatment_plans (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  patient_id uuid not null,
  template_id uuid,                                     -- SOP started on acceptance
  title text not null,
  options text,
  cost_paise bigint check (cost_paise is null or cost_paise >= 0),
  duration_months int check (duration_months is null or duration_months between 1 and 120),
  instalments int check (instalments is null or instalments between 1 and 36),
  status text not null default 'draft' check (status in ('draft','offered','accepted','declined','withdrawn')),
  decline_reason text check (decline_reason in ('price','timing','second_opinion','not_ready','no_need','other')),
  decline_note text,
  consent_signed_by text,
  consent_text_version text,
  patient_treatment_id uuid,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  offered_at timestamptz,
  accepted_at timestamptz,
  declined_at timestamptz,
  unique (id, clinic_id),
  foreign key (patient_id, clinic_id) references patients (id, clinic_id),
  foreign key (template_id, clinic_id) references sop_templates (id, clinic_id),
  foreign key (patient_treatment_id, clinic_id) references patient_treatments (id, clinic_id)
);
create index on treatment_plans (clinic_id, status, offered_at);

-- The patient's most recent open enquiry (by link or by phone), so plan stages stamp the funnel.
create or replace function enquiry_for_patient(p_patient uuid) returns uuid
language sql stable as $$
  select e.id from enquiries e join patients p on p.id = p_patient and p.clinic_id = e.clinic_id
   where e.status <> 'lost'
     and (e.patient_id = p_patient
          or right(regexp_replace(e.phone, '\D', '', 'g'), 10) = right(regexp_replace(p.phone, '\D', '', 'g'), 10))
   order by e.received_at desc limit 1
$$;

create or replace function offer_plan(p_plan uuid) returns void
language plpgsql as $$
declare v treatment_plans; v_enq uuid;
begin
  select * into v from treatment_plans where id = p_plan;
  if not found then raise exception 'plan not found'; end if;
  if coalesce(v.cost_paise, 0) <= 0 then raise exception 'add the estimated cost before offering the plan'; end if;
  update treatment_plans set status = 'offered', offered_at = now() where id = p_plan and status = 'draft';
  if not found then raise exception 'only a draft plan can be offered'; end if;
  v_enq := enquiry_for_patient(v.patient_id);
  if v_enq is not null then perform advance_enquiry(v_enq, 'plan_offered'); end if;
end $$;

-- Acceptance records the consent signature, starts the SOP (if chosen) and stamps "case started".
create or replace function accept_plan(p_plan uuid, p_signed_by text, p_consent_version text) returns uuid
language plpgsql as $$
declare v treatment_plans; v_treatment uuid; v_enq uuid;
begin
  select * into v from treatment_plans where id = p_plan;
  if not found then raise exception 'plan not found'; end if;
  if coalesce(my_role(v.clinic_id), '') not in ('owner','doctor','coordinator') then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if v.status <> 'offered' then raise exception 'only an offered plan can be accepted'; end if;
  if coalesce(trim(p_signed_by), '') = '' then raise exception 'who signed the consent?'; end if;

  insert into consents (clinic_id, patient_id, kind, text_version, given_by)
  values (v.clinic_id, v.patient_id, 'treatment', coalesce(nullif(trim(p_consent_version), ''), 'draft-v0'), trim(p_signed_by));
  if v.template_id is not null then
    v_treatment := start_treatment(v.patient_id, v.template_id,
                                   case when my_role(v.clinic_id) = 'doctor' then auth.uid() end, now());
    update patient_treatments set total_cost_paise = v.cost_paise where id = v_treatment;
  end if;
  update treatment_plans set status = 'accepted', accepted_at = now(), consent_signed_by = trim(p_signed_by),
         consent_text_version = coalesce(nullif(trim(p_consent_version), ''), 'draft-v0'), patient_treatment_id = v_treatment
   where id = p_plan;
  v_enq := enquiry_for_patient(v.patient_id);
  if v_enq is not null then perform advance_enquiry(v_enq, 'case_started'); end if;
  return v_treatment;
end $$;

create or replace function decline_plan(p_plan uuid, p_reason text, p_note text default null) returns void
language plpgsql as $$
begin
  if p_reason not in ('price','timing','second_opinion','not_ready','no_need','other') then
    raise exception 'choose a reason';
  end if;
  update treatment_plans set status = 'declined', declined_at = now(), decline_reason = p_reason,
         decline_note = nullif(left(trim(p_note), 500), '')
   where id = p_plan and status = 'offered';
  if not found then raise exception 'only an offered plan can be declined'; end if;
end $$;

-- "Quoted but not started" with reason codes.
create or replace view plan_outcomes with (security_invoker = true) as
select clinic_id, status, decline_reason, count(*) as n, coalesce(sum(cost_paise), 0) as value_paise
  from treatment_plans where status in ('offered','accepted','declined')
 group by 1, 2, 3;

-- =====================================================================
-- 30. Documents and clinical media (files in the private clinic-files bucket)
-- =====================================================================
alter table documents add column title text;
alter table documents add column content_type text;
alter table documents add column bytes int;
alter table documents add column uploaded_by uuid references auth.users(id);
alter table documents add column source text not null default 'staff' check (source in ('staff','whatsapp','smile_scan'));
alter table documents add column inbound_message_id uuid references inbound_messages(id);
alter table documents add constraint documents_kind_check
  check (kind in ('photo','xray','consent_form','scan','report','other')) not valid;

-- Documents are clinical: front desk no longer reads them (storage already refused them the files).
drop policy tenant_isolation on documents;
create policy documents_read on documents for select using (my_role(clinic_id) in ('owner','doctor','coordinator'));
create policy documents_insert on documents for insert with check (my_role(clinic_id) in ('owner','doctor','coordinator'));
create policy documents_delete on documents for delete using (my_role(clinic_id) in ('owner','doctor'));

-- =====================================================================
-- 31. Clinical notes and tooth charting, linked to the visit and SOP step
-- =====================================================================
alter table visit_notes add column treatment_step_id uuid;
alter table visit_notes add constraint visit_notes_step_same_clinic
  foreign key (treatment_step_id, clinic_id) references treatment_steps (id, clinic_id);
alter table tooth_chart_entries add column treatment_step_id uuid;
alter table tooth_chart_entries add constraint tooth_chart_step_same_clinic
  foreign key (treatment_step_id, clinic_id) references treatment_steps (id, clinic_id);
-- FDI two-digit notation: permanent 11-48, primary 51-85. To confirm with the doctor.
alter table tooth_chart_entries add constraint tooth_fdi
  check (tooth ~ '^([1-4][1-8]|[5-8][1-5])$') not valid;

-- =====================================================================
-- 32. Lab and vendor tracking: lab delays show as the cause of delayed cases
-- =====================================================================
alter table lab_orders add column note text;
alter table lab_orders add column created_by uuid references auth.users(id);

create or replace function set_lab_status(p_order uuid, p_status text) returns void
language plpgsql as $$
begin
  if p_status not in ('delivered','cancelled') then raise exception 'status must be delivered or cancelled'; end if;
  update lab_orders set status = p_status, delivered_at = case when p_status = 'delivered' then now() end
   where id = p_order and status = 'ordered';
  if not found then raise exception 'lab order not found, already closed, or not permitted'; end if;
end $$;

create or replace view delayed_cases with (security_invoker = true) as
select ds.clinic_id, ds.patient_treatment_id, ds.patient_id, p.full_name, ds.name as step_name, ds.due_at,
       extract(day from now() - ds.due_at)::int as days_late,
       lo.id as lab_order_id, lo.vendor, lo.item, lo.expected_at,
       case when lo.id is not null then 'Waiting on lab: ' || lo.vendor || ' (' || lo.item || ')'
            else 'Patient not seen' end as cause
  from delayed_steps ds
  join patients p on p.id = ds.patient_id
  left join lateral (
    select l.* from lab_orders l where l.treatment_step_id = ds.step_id and l.status = 'ordered'
     order by l.ordered_at desc limit 1) lo on true;

-- =====================================================================
-- 33. Retention phase after debond (a clinic-defined SOP that starts by itself)
-- =====================================================================
alter table sop_templates add column phase text not null default 'treatment' check (phase in ('treatment','retention'));
alter table sop_templates add column retention_sop_name text;

create or replace function sop_template_guard() returns trigger
language plpgsql as $$
begin
  if old.status <> 'draft' and (new.name <> old.name or new.version <> old.version
       or new.reviewed_by is distinct from old.reviewed_by or new.phase <> old.phase
       or new.retention_sop_name is distinct from old.retention_sop_name) then
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

create or replace function new_sop_version(p_template uuid) returns uuid
language plpgsql as $$
declare v sop_templates; v_new uuid;
begin
  select * into v from sop_templates where id = p_template;
  if not found then raise exception 'template not found'; end if;
  insert into sop_templates (clinic_id, name, version, status, phase, retention_sop_name)
  values (v.clinic_id, v.name,
          (select max(version) + 1 from sop_templates where clinic_id = v.clinic_id and name = v.name),
          'draft', v.phase, v.retention_sop_name)
  returning id into v_new;
  insert into sop_steps (clinic_id, template_id, position, name, days_after_previous)
  select clinic_id, v_new, position, name, days_after_previous from sop_steps where template_id = p_template;
  return v_new;
end $$;

-- When active treatment completes (debond), the named retention SOP starts from that day.
create or replace function start_retention_phase() returns trigger
language plpgsql as $$
declare v_name text; v_tpl uuid;
begin
  if new.status = 'completed' and old.status = 'active' then
    select retention_sop_name into v_name from sop_templates where id = new.template_id;
    if v_name is null then return new; end if;
    select id into v_tpl from sop_templates
     where clinic_id = new.clinic_id and name = v_name and status = 'published' and phase = 'retention'
     order by version desc limit 1;
    if v_tpl is not null and not exists (
      select 1 from patient_treatments where patient_id = new.patient_id and template_id = v_tpl and status = 'active') then
      perform start_treatment(new.patient_id, v_tpl, new.doctor_id, coalesce(new.completed_at, now()));
    end if;
  end if;
  return new;
end $$;
create trigger start_retention_phase after update of status on patient_treatments
  for each row execute function start_retention_phase();

-- =====================================================================
-- 39. Staff notifications (in the app, and push when the worker has VAPID keys)
-- =====================================================================
create table notifications (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null,
  title text not null,
  link text check (link is null or link ~ '^/[A-Za-z0-9/_?=&#-]*$'),
  urgent boolean not null default false,
  created_at timestamptz not null default now(),
  read_at timestamptz,
  pushed_at timestamptz
);
create index on notifications (user_id, read_at, created_at desc);
create index on notifications (pushed_at, created_at) where pushed_at is null;

create table push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null unique check (endpoint ~ '^https://'),
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
);

create or replace function notify_user(p_clinic uuid, p_user uuid, p_kind text, p_title text, p_link text, p_urgent boolean)
returns void
language sql security definer set search_path = public as $$
  insert into notifications (clinic_id, user_id, kind, title, link, urgent)
  select p_clinic, p_user, p_kind, left(p_title, 200), p_link, p_urgent
   where p_user is not null
     and exists (select 1 from clinic_members where clinic_id = p_clinic and user_id = p_user and active)
$$;

create or replace function notify_on_task() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.assignee_id is not null and new.assignee_id is distinct from new.created_by then
    perform notify_user(new.clinic_id, new.assignee_id, 'task', new.title,
                        case when new.patient_id is not null then '/patients/' || new.patient_id else '/tasks' end, false);
  end if;
  return new;
end $$;
create trigger notify_on_task after insert on tasks for each row execute function notify_on_task();

create or replace function notify_on_concern() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform notify_user(new.clinic_id, new.assigned_to, 'concern',
                      initcap(new.severity) || ' patient concern', '/concerns', new.severity = 'urgent');
  return new;
end $$;
create trigger notify_on_concern after insert on patient_concerns for each row execute function notify_on_concern();

create or replace function mark_notifications_read(p_ids uuid[] default null) returns void
language sql as $$
  update notifications set read_at = now()
   where user_id = auth.uid() and read_at is null and (p_ids is null or id = any(p_ids))
$$;

-- =====================================================================
-- 35. Patient feedback (ratings over WhatsApp after key visits)
-- =====================================================================
alter table clinics add column google_review_url text check (google_review_url is null or google_review_url ~ '^https://\S+$');

create table feedback_requests (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  patient_id uuid not null,
  trigger text not null check (trigger in ('first_consult','mid_treatment','debond')),
  appointment_id uuid,
  patient_treatment_id uuid,
  doctor_id uuid references auth.users(id),
  status text not null default 'not_sent' check (status in ('not_sent','sent','answered','expired')),
  outbound_message_id uuid references outbound_messages(id),
  rating int check (rating between 1 and 5),
  comment text,
  low_score_alerted boolean not null default false,
  review_prompted boolean not null default false,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  answered_at timestamptz,
  foreign key (patient_id, clinic_id) references patients (id, clinic_id),
  foreign key (appointment_id, clinic_id) references appointments (id, clinic_id),
  foreign key (patient_treatment_id, clinic_id) references patient_treatments (id, clinic_id)
);
create unique index feedback_one_per_consult on feedback_requests (appointment_id) where trigger = 'first_consult';
create unique index feedback_one_per_treatment_stage on feedback_requests (patient_treatment_id, trigger)
  where trigger in ('mid_treatment','debond');

-- Server only. After a first consultation, half-way through treatment, and after debond.
create or replace function enqueue_feedback_requests() returns int
language plpgsql as $$
declare r feedback_requests; v_msg uuid; n int := 0;
begin
  insert into feedback_requests (clinic_id, patient_id, trigger, appointment_id, doctor_id)
  select a.clinic_id, a.patient_id, 'first_consult', a.id, a.doctor_id from appointments a
   where a.visit_type = 'new' and a.status = 'completed' and a.starts_at > now() - interval '2 days'
  on conflict do nothing;

  insert into feedback_requests (clinic_id, patient_id, trigger, patient_treatment_id, doctor_id)
  select pt.clinic_id, pt.patient_id, 'mid_treatment', pt.id, pt.doctor_id from patient_treatments pt
   where pt.status = 'active'
     and (select count(*) from treatment_steps s where s.patient_treatment_id = pt.id) >= 4
     and (select count(*) from treatment_steps s where s.patient_treatment_id = pt.id and s.status = 'done')
         >= ceil((select count(*) from treatment_steps s where s.patient_treatment_id = pt.id) / 2.0)
  on conflict do nothing;

  insert into feedback_requests (clinic_id, patient_id, trigger, patient_treatment_id, doctor_id)
  select pt.clinic_id, pt.patient_id, 'debond', pt.id, pt.doctor_id
    from patient_treatments pt join sop_templates t on t.id = pt.template_id and t.phase = 'treatment'
   where pt.status = 'completed' and pt.completed_at > now() - interval '7 days'
  on conflict do nothing;

  for r in select * from feedback_requests where status = 'not_sent' and created_at > now() - interval '7 days' and sent_at is null loop
    v_msg := queue_patient_message(r.clinic_id, r.patient_id, 'feedback_request', 'feedback:' || r.id);
    if v_msg is not null then
      update feedback_requests set status = 'sent', sent_at = now(), outbound_message_id = v_msg where id = r.id;
      n := n + 1;
    else
      update feedback_requests set sent_at = now() where id = r.id;   -- tried once; no WhatsApp
    end if;
  end loop;
  update feedback_requests set status = 'expired' where status = 'sent' and sent_at < now() - interval '7 days';
  return n;
end $$;

create or replace view feedback_by_doctor with (security_invoker = true) as
select f.clinic_id, f.doctor_id, m.display_name as doctor_name,
       count(*) filter (where f.rating is not null) as answered,
       round(avg(f.rating)::numeric, 2) as average,
       count(*) filter (where f.rating <= 2) as low_scores
  from feedback_requests f left join clinic_members m on m.user_id = f.doctor_id and m.clinic_id = f.clinic_id
 group by 1, 2, 3;

-- =====================================================================
-- 40. Waitlist and cancellation fill
-- =====================================================================
create table waitlist_entries (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  patient_id uuid not null,
  doctor_id uuid references auth.users(id),
  earliest date not null,
  latest date not null,
  note text,
  status text not null default 'waiting' check (status in ('waiting','offered','booked','removed')),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  check (latest >= earliest),
  unique (id, clinic_id),
  foreign key (patient_id, clinic_id) references patients (id, clinic_id)
);
create table slot_offers (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  waitlist_entry_id uuid not null,
  patient_id uuid not null,
  cancelled_appointment_id uuid,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  doctor_id uuid,
  chair text,
  status text not null default 'offered' check (status in ('offered','accepted','declined','expired','booked')),
  outbound_message_id uuid references outbound_messages(id),
  booked_appointment_id uuid,
  created_at timestamptz not null default now(),
  responded_at timestamptz,
  foreign key (waitlist_entry_id, clinic_id) references waitlist_entries (id, clinic_id),
  foreign key (patient_id, clinic_id) references patients (id, clinic_id),
  foreign key (cancelled_appointment_id, clinic_id) references appointments (id, clinic_id),
  foreign key (booked_appointment_id, clinic_id) references appointments (id, clinic_id)
);
create index on slot_offers (patient_id, status, created_at);

-- A cancelled future slot is offered to the longest-waiting matching patient, one at a time.
create or replace function offer_cancelled_slot() returns trigger
language plpgsql security definer set search_path = public as $$
declare w waitlist_entries; v_tz text; v_offer uuid; v_msg uuid; v_name text;
begin
  if new.status = 'cancelled' and old.status is distinct from 'cancelled' and new.starts_at > now() + interval '2 hours' then
    select timezone into v_tz from clinics where id = new.clinic_id;
    select * into w from waitlist_entries e
     where e.clinic_id = new.clinic_id and e.status = 'waiting' and e.patient_id <> new.patient_id
       and (e.doctor_id is null or e.doctor_id = new.doctor_id)
       and (new.starts_at at time zone v_tz)::date between e.earliest and e.latest
     order by e.created_at limit 1;
    if w.id is null then return new; end if;
    insert into slot_offers (clinic_id, waitlist_entry_id, patient_id, cancelled_appointment_id, starts_at, ends_at, doctor_id, chair)
    values (new.clinic_id, w.id, w.patient_id, new.id, new.starts_at, new.ends_at, new.doctor_id, new.chair)
    returning id into v_offer;
    update waitlist_entries set status = 'offered' where id = w.id;
    v_msg := queue_patient_message(new.clinic_id, w.patient_id, 'slot_offer', 'slot:' || v_offer,
               jsonb_build_array(to_char(new.starts_at at time zone v_tz, 'Dy DD Mon'),
                                 to_char(new.starts_at at time zone v_tz, 'HH12:MI AM')));
    update slot_offers set outbound_message_id = v_msg where id = v_offer;
    select full_name into v_name from patients where id = w.patient_id;
    insert into tasks (clinic_id, assignee_id, patient_id, title, due_at, source)
    values (new.clinic_id, scan_task_owner(new.clinic_id), w.patient_id,
            'Earlier slot ' || to_char(new.starts_at at time zone v_tz, 'DD Mon HH12:MI AM') || ' offered to ' || v_name ||
            case when v_msg is null then ': call them (no WhatsApp)' else ': book it if they reply YES' end,
            now(), 'system');
  end if;
  return new;
end $$;
create trigger offer_cancelled_slot after update of status on appointments
  for each row execute function offer_cancelled_slot();

-- Staff book an accepted (or phoned-in) offer into the freed slot.
create or replace function book_slot_offer(p_offer uuid) returns uuid
language plpgsql as $$
declare o slot_offers; v_id uuid;
begin
  select * into o from slot_offers where id = p_offer;
  if not found then raise exception 'offer not found'; end if;
  if o.status not in ('offered','accepted') then raise exception 'this offer is %', o.status; end if;
  insert into appointments (clinic_id, patient_id, doctor_id, chair, starts_at, ends_at, visit_type)
  values (o.clinic_id, o.patient_id, o.doctor_id, o.chair, o.starts_at, o.ends_at, 'follow_up')
  returning id into v_id;
  update slot_offers set status = 'booked', booked_appointment_id = v_id, responded_at = coalesce(responded_at, now()) where id = p_offer;
  update waitlist_entries set status = 'booked' where id = o.waitlist_entry_id;
  return v_id;
end $$;

-- Server only. Offers not answered within a day go back to the waitlist.
create or replace function expire_slot_offers() returns int
language plpgsql as $$
declare n int;
begin
  with x as (
    update slot_offers set status = 'expired'
     where status = 'offered' and (created_at < now() - interval '24 hours' or starts_at < now())
    returning waitlist_entry_id)
  update waitlist_entries w set status = 'waiting' from x where w.id = x.waitlist_entry_id and w.status = 'offered';
  get diagnostics n = row_count;
  return n;
end $$;

-- =====================================================================
-- 34 + 35 + 40. Inbound messages: photos, ratings and slot replies, before check-ins
-- =====================================================================
alter table inbound_messages add column media_id text;
alter table inbound_messages add column media_type text;

drop function if exists record_inbound_message(uuid, text, text, text);
-- Server only. result: duplicate | stop | unknown_sender | photo | feedback | slot_reply | checkin_reply | reply
create function record_inbound_message(
  p_clinic uuid, p_phone text, p_body text, p_provider_id text default null,
  p_media_id text default null, p_media_type text default null
) returns table (result text, inbound_id uuid, patient_id uuid, checkin_id uuid)
language plpgsql as $$
declare
  v_patient uuid; v_name text; v_inserted uuid; v_checkin uuid; v_body text := trim(coalesce(p_body, ''));
  f feedback_requests; o slot_offers; v_rating int; v_url text; v_tz text;
begin
  -- Families often share one phone: the reply belongs to whoever we messaged last, then to an opted-in patient.
  select p.id, p.full_name into v_patient, v_name from patients p
   where p.clinic_id = p_clinic and p.deleted_at is null
     and right(regexp_replace(p.phone, '\D', '', 'g'), 10) = right(regexp_replace(p_phone, '\D', '', 'g'), 10)
   order by (select max(om.created_at) from outbound_messages om where om.patient_id = p.id) desc nulls last,
            p.whatsapp_opt_in desc, p.created_at desc
   limit 1;

  insert into inbound_messages (clinic_id, patient_id, from_phone, body, provider_message_id, media_id, media_type)
  values (p_clinic, v_patient, p_phone, left(v_body, 2000), p_provider_id, p_media_id, p_media_type)
  on conflict (clinic_id, provider_message_id) where provider_message_id is not null do nothing
  returning id into v_inserted;
  if v_inserted is null then
    return query select 'duplicate'::text, null::uuid, v_patient, null::uuid; return;
  end if;

  if upper(v_body) in ('STOP','STOP ALL','UNSUBSCRIBE') then
    if v_patient is not null then
      insert into whatsapp_opt_events (clinic_id, patient_id, event, source)
      values (p_clinic, v_patient, 'opt_out', 'whatsapp_stop');
    end if;
    return query select 'stop'::text, v_inserted, v_patient, null::uuid; return;
  end if;

  if v_patient is null then
    return query select 'unknown_sender'::text, v_inserted, null::uuid, null::uuid; return;
  end if;

  if p_media_id is not null then
    return query select 'photo'::text, v_inserted, v_patient, null::uuid; return;
  end if;

  -- A rating: "5", "4 - great", "3/5" in reply to a recent feedback request.
  select * into f from feedback_requests fr
   where fr.patient_id = v_patient and fr.status = 'sent' and fr.sent_at > now() - interval '7 days'
   order by fr.sent_at desc limit 1;
  if f.id is not null and v_body ~ '^[1-5](\s*/\s*5)?(\D.*)?$' then
    v_rating := substr(v_body, 1, 1)::int;
    update feedback_requests set status = 'answered', rating = v_rating, answered_at = now(),
           comment = nullif(trim(regexp_replace(v_body, '^[1-5](\s*/\s*5)?[\s.,:-]*', '')), '')
     where id = f.id;
    if v_rating <= 2 then
      -- Private alert to the owner before it becomes a public review.
      insert into tasks (clinic_id, assignee_id, patient_id, title, due_at, source)
      select p_clinic, m.user_id, v_patient,
             'Low feedback (' || v_rating || '/5) from ' || v_name || ': call them', now(), 'system'
        from clinic_members m where m.clinic_id = p_clinic and m.role = 'owner' and m.active
       order by m.created_at limit 1;
      update feedback_requests set low_score_alerted = true where id = f.id;
    elsif v_rating = 5 then
      select google_review_url into v_url from clinics where id = p_clinic;
      if v_url is not null and queue_patient_message(p_clinic, v_patient, 'google_review', 'review:' || f.id,
                                                     jsonb_build_array(v_url)) is not null then
        update feedback_requests set review_prompted = true where id = f.id;
      end if;
    end if;
    return query select 'feedback'::text, v_inserted, v_patient, null::uuid; return;
  end if;

  -- YES or NO to an earlier slot.
  select * into o from slot_offers so
   where so.patient_id = v_patient and so.status = 'offered' and so.created_at > now() - interval '24 hours'
   order by so.created_at desc limit 1;
  if o.id is not null and lower(v_body) ~ '^(yes|y|ok|okay|haan|ha|han|sure|confirm|👍)(\W|$)' then
    select timezone into v_tz from clinics where id = p_clinic;
    update slot_offers set status = 'accepted', responded_at = now() where id = o.id;
    insert into tasks (clinic_id, assignee_id, patient_id, title, due_at, source)
    values (p_clinic, scan_task_owner(p_clinic), v_patient,
            v_name || ' accepted the slot on ' || to_char(o.starts_at at time zone v_tz, 'DD Mon HH12:MI AM') ||
            ': book it on the Waitlist page', now(), 'system');
    return query select 'slot_reply'::text, v_inserted, v_patient, null::uuid; return;
  elsif o.id is not null and lower(v_body) ~ '^(no|n|nahi|nope|not now)(\W|$)' then
    update slot_offers set status = 'declined', responded_at = now() where id = o.id;
    update waitlist_entries set status = 'waiting' where id = o.waitlist_entry_id and status = 'offered';
    return query select 'slot_reply'::text, v_inserted, v_patient, null::uuid; return;
  end if;

  select k.id into v_checkin from checkins k
   where k.patient_id = v_patient and k.clinic_id = p_clinic and k.status = 'sent'
     and k.reply_inbound_id is null and k.sent_at > now() - interval '7 days'
   order by k.sent_at desc limit 1;
  if v_checkin is not null then
    update checkins set reply_inbound_id = v_inserted, reply_text = left(v_body, 2000), replied_at = now()
     where id = v_checkin;
    return query select 'checkin_reply'::text, v_inserted, v_patient, v_checkin; return;
  end if;

  insert into tasks (clinic_id, assignee_id, patient_id, title, due_at, source)
  values (p_clinic, scan_task_owner(p_clinic), v_patient,
          'Reply to ' || v_name || ' on WhatsApp: "' || left(v_body, 80) || '"', now(), 'system');
  return query select 'reply'::text, v_inserted, v_patient, null::uuid;
end $$;

create or replace function has_photo_consent(p_patient uuid) returns boolean
language sql stable as $$
  select exists (select 1 from consents where patient_id = p_patient and kind = 'photo_use' and withdrawn_at is null)
$$;

-- Server only. With consent the stored photo is attached and a clinician asked to look at it;
-- without consent nothing is stored and staff are asked to get consent.
create or replace function handle_whatsapp_photo(
  p_inbound uuid, p_path text default null, p_content_type text default null, p_bytes int default null
) returns text
language plpgsql as $$
declare m inbound_messages; v_name text;
begin
  select * into m from inbound_messages where id = p_inbound;
  if not found or m.patient_id is null then return 'ignored'; end if;
  select full_name into v_name from patients where id = m.patient_id;
  if p_path is null then
    insert into tasks (clinic_id, assignee_id, patient_id, title, due_at, source)
    values (m.clinic_id, scan_task_owner(m.clinic_id), m.patient_id,
            v_name || ' sent a photo on WhatsApp. It was not stored: record photo consent and ask them to resend', now(), 'system');
    return 'no_consent';
  end if;
  insert into documents (clinic_id, patient_id, kind, storage_path, title, content_type, bytes, source, inbound_message_id)
  values (m.clinic_id, m.patient_id, 'photo', p_path, 'Photo sent on WhatsApp', p_content_type, p_bytes, 'whatsapp', p_inbound);
  insert into tasks (clinic_id, assignee_id, patient_id, title, due_at, source)
  values (m.clinic_id, coalesce(clinician_for(m.patient_id), scan_task_owner(m.clinic_id)), m.patient_id,
          'Review the photo ' || v_name || ' sent on WhatsApp', now(), 'system');
  return 'stored';
end $$;

-- =====================================================================
-- 37. Marketing source report, with optional ad spend
-- =====================================================================
create table ad_spend (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  month date not null check (extract(day from month) = 1),
  source lead_source not null,
  amount_paise bigint not null check (amount_paise >= 0),
  unique (clinic_id, month, source)
);

create or replace function source_report(p_from date, p_to date)
returns table (source text, leads bigint, consults_booked bigint, cases_started bigint, registrations bigint, spend_paise bigint)
language sql stable as $$
  with c as (select id, timezone from clinics where id in (select my_clinic_ids()) limit 1),
  s as (select unnest(enum_range(null::lead_source))::text as source)
  select s.source,
    (select count(*) from enquiries e, c where e.clinic_id = c.id and e.lead_source::text = s.source
       and (e.received_at at time zone c.timezone)::date between p_from and p_to),
    (select count(*) from enquiries e, c where e.clinic_id = c.id and e.lead_source::text = s.source
       and e.consult_booked_at is not null and (e.received_at at time zone c.timezone)::date between p_from and p_to),
    (select count(*) from enquiries e, c where e.clinic_id = c.id and e.lead_source::text = s.source
       and e.case_started_at is not null and (e.received_at at time zone c.timezone)::date between p_from and p_to),
    (select count(*) from patients p, c where p.clinic_id = c.id and p.lead_source::text = s.source and p.deleted_at is null
       and (p.created_at at time zone c.timezone)::date between p_from and p_to),
    (select coalesce(sum(a.amount_paise), 0)::bigint from ad_spend a, c where a.clinic_id = c.id and a.source::text = s.source
       and a.month between date_trunc('month', p_from)::date and p_to)
  from s
$$;

-- "The dashboard should show how complete [the source field] is each month."
create or replace function source_completion(p_months int default 6)
returns table (month date, registered bigint, with_source bigint)
language sql stable as $$
  with c as (select id, timezone from clinics where id in (select my_clinic_ids()) limit 1)
  select date_trunc('month', (p.created_at at time zone c.timezone))::date, count(*), count(p.lead_source)
    from patients p, c
   where p.clinic_id = c.id and p.deleted_at is null
     and p.created_at > now() - make_interval(months => least(greatest(p_months, 1), 24))
   group by 1 order by 1 desc
$$;

-- =====================================================================
-- 38. Duplicate detection, family linking and merge
-- =====================================================================
create table patient_family_links (
  clinic_id uuid not null references clinics(id) on delete cascade,
  patient_id uuid not null,
  related_patient_id uuid not null,
  relation text not null default 'family',
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  primary key (patient_id, related_patient_id),
  check (patient_id < related_patient_id),
  foreign key (patient_id, clinic_id) references patients (id, clinic_id),
  foreign key (related_patient_id, clinic_id) references patients (id, clinic_id)
);
create table patient_not_duplicates (
  clinic_id uuid not null references clinics(id) on delete cascade,
  patient_a uuid not null,
  patient_b uuid not null,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  primary key (patient_a, patient_b),
  check (patient_a < patient_b)
);
create table patient_merges (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  kept_patient_id uuid not null,
  merged_patient_id uuid not null,
  merged_by uuid references auth.users(id),
  merged_at timestamptz not null default now(),
  snapshot jsonb not null
);

-- Same phone (last 10 digits), or same name and date of birth. Family links and "not duplicates" are left out.
create or replace view duplicate_candidates with (security_invoker = true) as
select a.clinic_id, a.id as patient_a, b.id as patient_b, a.full_name as name_a, b.full_name as name_b,
       a.phone as phone_a, b.phone as phone_b, a.dob as dob_a, b.dob as dob_b,
       case when right(regexp_replace(a.phone, '\D', '', 'g'), 10) = right(regexp_replace(b.phone, '\D', '', 'g'), 10)
            then 'same phone' else 'same name and date of birth' end as reason
  from patients a join patients b on b.clinic_id = a.clinic_id and a.id < b.id
 where a.deleted_at is null and b.deleted_at is null
   and (right(regexp_replace(a.phone, '\D', '', 'g'), 10) = right(regexp_replace(b.phone, '\D', '', 'g'), 10)
        or (lower(trim(a.full_name)) = lower(trim(b.full_name)) and a.dob = b.dob))
   and not exists (select 1 from patient_family_links f where f.patient_id = a.id and f.related_patient_id = b.id)
   and not exists (select 1 from patient_not_duplicates d where d.patient_a = a.id and d.patient_b = b.id);

-- Moves everything from p_merge onto p_keep, fills blanks, and soft-deletes p_merge with a snapshot.
create or replace function merge_patients(p_keep uuid, p_merge uuid) returns void
language plpgsql security definer set search_path = public as $$
declare k patients; m patients; t record; v_opt text;
begin
  select * into k from patients where id = p_keep and deleted_at is null;
  select * into m from patients where id = p_merge and deleted_at is null;
  if k.id is null or m.id is null or k.id = m.id or k.clinic_id <> m.clinic_id then
    raise exception 'choose two different patients in the same clinic';
  end if;
  if coalesce(my_role(k.clinic_id), '') not in ('owner','coordinator') then
    raise exception 'only the owner or a coordinator can merge patients' using errcode = '42501';
  end if;

  -- One open recall per patient: close the merged one first if both have one.
  update recalls set status = 'closed', reason = 'merged', closed_at = now()
   where patient_id = p_merge and status = 'open'
     and exists (select 1 from recalls r where r.patient_id = p_keep and r.status = 'open');

  for t in select * from (values
    ('consents','patient_id'), ('enquiries','patient_id'), ('enquiries','referrer_patient_id'),
    ('appointments','patient_id'), ('patient_treatments','patient_id'), ('documents','patient_id'),
    ('visit_notes','patient_id'), ('tooth_chart_entries','patient_id'), ('lab_orders','patient_id'),
    ('invoices','patient_id'), ('whatsapp_opt_events','patient_id'), ('ai_actions','patient_id'),
    ('tasks','patient_id'), ('outbound_messages','patient_id'), ('inbound_messages','patient_id'),
    ('smile_scans','patient_id'), ('checkins','patient_id'), ('patient_concerns','patient_id'),
    ('recalls','patient_id'), ('treatment_plans','patient_id'), ('feedback_requests','patient_id'),
    ('waitlist_entries','patient_id'), ('slot_offers','patient_id'), ('patients','referred_by_patient_id')
  ) as v(tbl, col) loop
    execute format('update %I set %I = $1 where %I = $2', t.tbl, t.col, t.col) using p_keep, p_merge;
  end loop;

  -- Family links: drop ones that would become self-links or duplicates, re-point the rest.
  delete from patient_family_links where (patient_id = p_merge and related_patient_id = p_keep)
     or (patient_id = p_keep and related_patient_id = p_merge);
  insert into patient_family_links (clinic_id, patient_id, related_patient_id, relation, created_by, created_at)
  select clinic_id, least(p_keep, other), greatest(p_keep, other), relation, created_by, created_at from (
    select clinic_id, case when patient_id = p_merge then related_patient_id else patient_id end as other,
           relation, created_by, created_at
      from patient_family_links where patient_id = p_merge or related_patient_id = p_merge) x
  on conflict do nothing;
  delete from patient_family_links where patient_id = p_merge or related_patient_id = p_merge;
  delete from patient_not_duplicates where patient_a in (p_keep, p_merge) and patient_b in (p_keep, p_merge);

  -- Medical details: keep both histories.
  if exists (select 1 from patient_medical where patient_id = p_merge) then
    if exists (select 1 from patient_medical where patient_id = p_keep) then
      update patient_medical k2 set
        allergies = (select array(select distinct unnest(k2.allergies || m2.allergies))),
        medical_history = jsonb_build_object('notes', concat_ws(E'\n\n', k2.medical_history->>'notes',
                            nullif(m2.medical_history->>'notes', '')))
        from patient_medical m2 where k2.patient_id = p_keep and m2.patient_id = p_merge;
      delete from patient_medical where patient_id = p_merge;
    else
      update patient_medical set patient_id = p_keep where patient_id = p_merge;
    end if;
  end if;

  update patients set
    email = coalesce(email, m.email), dob = coalesce(dob, m.dob), sex = coalesce(sex, m.sex),
    address = coalesce(address, m.address), guardian_name = coalesce(guardian_name, m.guardian_name),
    guardian_phone = coalesce(guardian_phone, m.guardian_phone), lead_source = coalesce(lead_source, m.lead_source),
    notes = concat_ws(E'\n', notes, nullif('Merged with ' || m.full_name || ' (' || m.phone || ')', ''))
   where id = p_keep;
  -- WhatsApp opt-in follows the latest event across both records.
  select event into v_opt from whatsapp_opt_events where patient_id = p_keep order by at desc limit 1;
  update patients set whatsapp_opt_in = coalesce(v_opt = 'opt_in', false) where id = p_keep;

  update patients set deleted_at = now(), notes = concat_ws(E'\n', notes, 'Merged into ' || p_keep) where id = p_merge;
  insert into patient_merges (clinic_id, kept_patient_id, merged_patient_id, merged_by, snapshot)
  values (k.clinic_id, p_keep, p_merge, auth.uid(), to_jsonb(m));
end $$;

-- =====================================================================
-- Today queue: lab orders that are late and hold up a step
-- =====================================================================
create or replace view today_queue with (security_invoker = true) as
select q.*,
       coalesce((select count(*) from appointments x where x.patient_id = q.patient_id and x.status = 'no_show'
                   and x.starts_at > now() - interval '180 days'), 0)::int as patient_no_shows
from (
  select t.clinic_id, 'task'::text as kind, t.id as ref_id, t.patient_id, t.title,
         t.due_at, t.assignee_id, null::text as severity, null::bigint as amount_paise
    from tasks t join clinics c on c.id = t.clinic_id
   where t.status = 'open'
     and (t.due_at is null
          or t.due_at < ((date_trunc('day', now() at time zone c.timezone) + interval '1 day') at time zone c.timezone))
  union all
  select ds.clinic_id, 'overdue_step', ds.step_id, ds.patient_id, ds.name, ds.due_at, null::uuid, null, null
    from delayed_steps ds
  union all
  select e.clinic_id, 'enquiry_unreplied', e.id, e.patient_id, 'Reply to ' || e.name,
         e.received_at + make_interval(mins => c.reply_sla_minutes), e.owner_id, null, null
    from enquiries e join clinics c on c.id = e.clinic_id
   where e.first_replied_at is null and e.status <> 'lost'
     and e.received_at + make_interval(mins => c.reply_sla_minutes) < now()
  union all
  select s.clinic_id, 'scan_review', s.id, s.patient_id, 'Review Smile Passport scan: ' || s.full_name,
         s.review_due_at, s.reviewer_id, null, null
    from smile_scans s where s.status in ('submitted','in_review')
  union all
  select pc.clinic_id, 'concern', pc.id, pc.patient_id,
         initcap(pc.severity) || ' concern: ' || p.full_name || coalesce(' (' || pc.topic || ')', ''),
         pc.created_at, pc.assigned_to, pc.severity, null
    from patient_concerns pc join patients p on p.id = pc.patient_id
   where pc.status <> 'resolved'
  union all
  select k.clinic_id, 'checkin_call', k.id, k.patient_id, 'Check in with ' || p.full_name || ' by phone',
         k.created_at, null::uuid, null, null
    from checkins k join patients p on p.id = k.patient_id
   where k.status = 'pending'
  union all
  select pm.clinic_id, 'payment_overdue', pm.id, pt.patient_id, 'Collect overdue instalment from ' || p.full_name,
         (pm.due_date::timestamp at time zone c.timezone), null::uuid, null,
         pm.amount_paise - coalesce(pm.paid_amount_paise, 0)
    from payments pm
    join patient_treatments pt on pt.id = pm.patient_treatment_id
    join patients p on p.id = pt.patient_id
    join clinics c on c.id = pm.clinic_id
   where pm.paid_at is null and pm.due_date < (now() at time zone c.timezone)::date
  union all
  select l.clinic_id, 'lab_overdue', l.id, l.patient_id, 'Chase ' || l.vendor || ' for ' || p.full_name || '''s ' || l.item,
         l.expected_at, l.created_by, null, null
    from lab_orders l join patients p on p.id = l.patient_id
   where l.status = 'ordered' and l.expected_at < now()
) q;

-- Weekly summaries are read-only, not drafts: keep them out of the draft acceptance rates.
create or replace view ai_draft_stats with (security_invoker = true) as
select clinic_id, feature,
       count(*) filter (where outcome = 'sent')        as sent_as_is,
       count(*) filter (where outcome = 'edited_sent') as edited,
       count(*) filter (where outcome = 'discarded')   as discarded,
       count(*) filter (where outcome = 'pending')     as pending
  from ai_actions where feature not in ('checkin_classification','weekly_summary')
 group by clinic_id, feature;

-- =====================================================================
-- RLS, 2FA, audit, grants
-- =====================================================================
do $$
declare t text;
begin
  foreach t in array array['treatment_plans','notifications','push_subscriptions','feedback_requests','waitlist_entries',
                           'slot_offers','ad_spend','patient_family_links','patient_not_duplicates','patient_merges'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy mfa_required on %I as restrictive for all to authenticated
                    using ((select mfa_ok())) with check ((select mfa_ok()))', t);
  end loop;
  foreach t in array array['treatment_plans','feedback_requests','waitlist_entries','slot_offers','ad_spend',
                           'patient_family_links','patient_not_duplicates','patient_merges'] loop
    execute format('create trigger audit_%1$s after insert or update or delete on %1$s
                    for each row execute function audit_row()', t);
  end loop;
end $$;

-- Plans hold prices and clinical options: front desk excluded, as with treatments' finances.
create policy plans_read on treatment_plans for select using (my_role(clinic_id) in ('owner','doctor','coordinator'));
create policy plans_write on treatment_plans for all
  using (my_role(clinic_id) in ('owner','doctor','coordinator'))
  with check (my_role(clinic_id) in ('owner','doctor','coordinator'));

create policy notifications_own on notifications for select using (user_id = auth.uid());
create policy notifications_own_update on notifications for update using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy push_own on push_subscriptions for all
  using (user_id = auth.uid()) with check (user_id = auth.uid() and clinic_id in (select my_clinic_ids()));

create policy feedback_read on feedback_requests for select using (my_role(clinic_id) in ('owner','doctor','coordinator'));

create policy waitlist_rw on waitlist_entries for all
  using (clinic_id in (select my_clinic_ids())) with check (clinic_id in (select my_clinic_ids()));
create policy offers_read on slot_offers for select using (clinic_id in (select my_clinic_ids()));
create policy offers_update on slot_offers for update
  using (clinic_id in (select my_clinic_ids())) with check (clinic_id in (select my_clinic_ids()));

create policy spend_rw on ad_spend for all
  using (my_role(clinic_id) in ('owner','coordinator')) with check (my_role(clinic_id) in ('owner','coordinator'));

create policy family_read on patient_family_links for select using (clinic_id in (select my_clinic_ids()));
create policy family_write on patient_family_links for all
  using (my_role(clinic_id) in ('owner','coordinator')) with check (my_role(clinic_id) in ('owner','coordinator'));
create policy notdup_rw on patient_not_duplicates for all
  using (my_role(clinic_id) in ('owner','coordinator')) with check (my_role(clinic_id) in ('owner','coordinator'));
create policy merges_read on patient_merges for select using (my_role(clinic_id) in ('owner','coordinator'));

do $$
declare f text;
begin
  foreach f in array array[
    'record_inbound_message(uuid,text,text,text,text,text)', 'handle_whatsapp_photo(uuid,text,text,int)',
    'enqueue_feedback_requests()', 'expire_slot_offers()', 'notify_user(uuid,uuid,text,text,text,boolean)'
  ] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;
revoke execute on function merge_patients(uuid, uuid) from public, anon;
grant execute on function merge_patients(uuid, uuid) to authenticated;
