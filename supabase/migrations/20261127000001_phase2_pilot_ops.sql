-- Phase 2: Pilot-ready operations (roadmap v3, features #15 to #27).
--   0 shared helpers (patient messages without an appointment, who gets clinical work)
--  15 patient import with dry run          16 WhatsApp comfort check-ins
--  17 AI platform foundation (switches, review, rates)   18 enquiry reply drafts (knowledge base)
--  19 reply classification results        20 patient concerns
--  21 no-show and lapsed recovery         22 instalments, receipts and invoices (GST-ready)
--  23 emergency visits                    24 owner dashboard numbers
--  25 Today queue ranking inputs          26 drop-off risk flags
--  27 usage analytics and pilot success metrics
-- Functions marked "server only" are called by the worker or webhook with the service role.

-- =====================================================================
-- 0. Shared helpers
-- =====================================================================
-- Messages that do not belong to an appointment (check-ins, recalls, reminders) are made
-- idempotent with a dedupe key, and can carry extra template parameters.
alter table outbound_messages add column dedupe_key text;
alter table outbound_messages add column params jsonb not null default '[]';
create unique index outbound_dedupe_key on outbound_messages (clinic_id, dedupe_key) where dedupe_key is not null;

-- Queues an approved template in the patient's language, only for an opted-in patient.
-- Returns the message id, or null when nothing could be queued (no opt-in or no approved template).
create or replace function queue_patient_message(
  p_clinic uuid, p_patient uuid, p_key text, p_dedupe text,
  p_params jsonb default '[]', p_at timestamptz default now()
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_tpl uuid; v_id uuid;
begin
  select t.id into v_tpl
    from patients p
    join message_templates t on t.clinic_id = p.clinic_id and t.key = p_key
                            and t.language = p.preferred_language and t.approved
   where p.id = p_patient and p.clinic_id = p_clinic and p.whatsapp_opt_in and p.deleted_at is null;
  if v_tpl is null then return null; end if;
  insert into outbound_messages (clinic_id, patient_id, template_id, kind, scheduled_for, dedupe_key, params)
  values (p_clinic, p_patient, v_tpl, p_key, p_at, p_dedupe, coalesce(p_params, '[]'::jsonb))
  on conflict (clinic_id, dedupe_key) where dedupe_key is not null do nothing
  returning id into v_id;
  if v_id is null then
    select id into v_id from outbound_messages where clinic_id = p_clinic and dedupe_key = p_dedupe;
  end if;
  return v_id;
end $$;

-- The clinician responsible for a patient: the doctor on their active treatment, else a doctor, else the owner.
create or replace function clinician_for(p_patient uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select pt.doctor_id from patient_treatments pt
       join clinic_members m on m.user_id = pt.doctor_id and m.clinic_id = pt.clinic_id and m.active
      where pt.patient_id = p_patient and pt.status = 'active'
      order by pt.started_at desc nulls last limit 1),
    (select m.user_id from clinic_members m join patients p on p.clinic_id = m.clinic_id
      where p.id = p_patient and m.active and m.role in ('doctor','owner')
      order by (m.role = 'doctor') desc, m.created_at limit 1))
$$;

-- Clinic-local "today".
create or replace function clinic_today(p_clinic uuid) returns date
language sql stable as $$
  select (now() at time zone coalesce((select timezone from clinics where id = p_clinic), 'Asia/Kolkata'))::date
$$;

-- =====================================================================
-- 15. Patient import (dry run first, then commit)
-- =====================================================================
create table patient_imports (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  file_name text,
  dry_run boolean not null,
  total_rows int not null,
  imported int not null default 0,
  duplicates int not null default 0,
  errors int not null default 0,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
alter table patients add column import_id uuid references patient_imports(id);

-- p_rows: [{row, full_name, phone, email, dob, sex, preferred_language, guardian_name, guardian_phone,
--           lead_source, notes}] already shape-checked by the app. Every row is re-checked here.
-- Duplicates (same last 10 phone digits, in the clinic or earlier in the file) are skipped unless
-- p_allow_duplicates. Nothing is written when p_commit is false (the dry run).
-- Imported patients have no WhatsApp opt-in: opt-in must be captured from the patient with a source and time.
create or replace function import_patients(
  p_rows jsonb, p_commit boolean, p_allow_duplicates boolean default false, p_file_name text default null
) returns table (row_no int, result text, message text, patient_id uuid)
language plpgsql as $$
declare
  v_clinic uuid; v_import uuid; r jsonb; v_phone10 text; v_dupe uuid; v_id uuid; v_err text;
  v_seen text[] := '{}'; n_ok int := 0; n_dup int := 0; n_err int := 0; v_dob date;
begin
  select clinic_id into v_clinic from clinic_members
   where user_id = auth.uid() and active and role in ('owner','coordinator') limit 1;
  if v_clinic is null then
    raise exception 'only the owner or a coordinator can import patients' using errcode = '42501';
  end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'no rows to import';
  end if;
  if jsonb_array_length(p_rows) > 5000 then raise exception 'import at most 5000 rows at a time'; end if;

  insert into patient_imports (clinic_id, file_name, dry_run, total_rows, created_by)
  values (v_clinic, left(p_file_name, 200), not p_commit, jsonb_array_length(p_rows), auth.uid())
  returning id into v_import;

  for r in select * from jsonb_array_elements(p_rows) loop
    row_no := coalesce((r->>'row')::int, 0); patient_id := null; message := null; v_dob := null;
    v_phone10 := right(regexp_replace(coalesce(r->>'phone', ''), '\D', '', 'g'), 10);
    v_err := case
      when coalesce(trim(r->>'full_name'), '') = '' then 'name is missing'
      when length(v_phone10) <> 10 then 'phone is not a 10-digit number'
      when r->>'lead_source' is not null
           and r->>'lead_source' not in (select unnest(enum_range(null::lead_source))::text) then 'unknown lead source'
    end;
    begin
      v_dob := nullif(r->>'dob', '')::date;
    exception when others then
      v_err := coalesce(v_err, 'date of birth is not a date (use YYYY-MM-DD)');
    end;
    if v_err is null and v_dob is not null and v_dob > (current_date - interval '18 years')::date
       and coalesce(trim(r->>'guardian_name'), '') = '' then
      v_err := 'a guardian name is required for patients under 18';
    end if;
    if v_err is not null then
      result := 'error'; message := v_err; n_err := n_err + 1; return next; continue;
    end if;

    select p.id into v_dupe from patients p
     where p.clinic_id = v_clinic and p.deleted_at is null
       and right(regexp_replace(p.phone, '\D', '', 'g'), 10) = v_phone10 limit 1;
    if (v_dupe is not null or v_phone10 = any(v_seen)) and not p_allow_duplicates then
      result := 'duplicate'; patient_id := v_dupe;
      message := case when v_dupe is not null then 'a patient with this phone already exists'
                      else 'this phone appears earlier in the file' end;
      n_dup := n_dup + 1; v_seen := v_seen || v_phone10; return next; continue;
    end if;
    v_seen := v_seen || v_phone10;

    if p_commit then
      insert into patients (clinic_id, full_name, phone, email, dob, sex, preferred_language,
                            guardian_name, guardian_phone, lead_source, notes, import_id)
      values (v_clinic, trim(r->>'full_name'), v_phone10, nullif(trim(r->>'email'), ''), v_dob,
              nullif(trim(r->>'sex'), ''), coalesce(nullif(r->>'preferred_language', ''), 'en'),
              nullif(trim(r->>'guardian_name'), ''), nullif(trim(r->>'guardian_phone'), ''),
              nullif(r->>'lead_source', '')::lead_source, nullif(trim(r->>'notes'), ''), v_import)
      returning id into v_id;
      patient_id := v_id;
    end if;
    result := 'ok'; n_ok := n_ok + 1; return next;
  end loop;

  update patient_imports set imported = case when p_commit then n_ok else 0 end,
         duplicates = n_dup, errors = n_err where id = v_import;
end $$;

-- =====================================================================
-- 16. WhatsApp comfort check-ins
-- =====================================================================
alter table clinics add column checkin_days_after int not null default 2
  check (checkin_days_after between 0 and 30);

create table checkins (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  patient_id uuid not null,
  treatment_step_id uuid,
  -- pending: could not be sent on WhatsApp, staff check in by phone
  status text not null default 'pending'
    check (status in ('pending','sent','ok','concern','no_reply','cancelled')),
  outbound_message_id uuid references outbound_messages(id),
  reply_inbound_id uuid,
  reply_text text,
  classification text check (classification in ('fine','mild','urgent','unknown')),
  topic text,
  confidence numeric,
  staff_note text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  replied_at timestamptz,
  unique (treatment_step_id),
  unique (id, clinic_id),
  foreign key (patient_id, clinic_id) references patients (id, clinic_id),
  foreign key (treatment_step_id, clinic_id) references treatment_steps (id, clinic_id)
);
create index on checkins (clinic_id, status, created_at);
create index on checkins (patient_id, status);

-- Server only. A check-in a few days after each completed step; also marks old unanswered ones.
create or replace function enqueue_checkins() returns int
language plpgsql as $$
declare r record; n int := 0; v_id uuid; v_msg uuid;
begin
  for r in
    select ts.id as step_id, ts.clinic_id, pt.patient_id
      from treatment_steps ts
      join patient_treatments pt on pt.id = ts.patient_treatment_id
      join clinics c on c.id = ts.clinic_id
      join patients p on p.id = pt.patient_id and p.deleted_at is null
     where ts.status = 'done'
       and ts.completed_at <= now() - make_interval(days => c.checkin_days_after)
       and ts.completed_at >  now() - make_interval(days => c.checkin_days_after + 7)
       and not exists (select 1 from checkins k where k.treatment_step_id = ts.id)
  loop
    insert into checkins (clinic_id, patient_id, treatment_step_id)
    values (r.clinic_id, r.patient_id, r.step_id) returning id into v_id;
    v_msg := queue_patient_message(r.clinic_id, r.patient_id, 'comfort_checkin', 'checkin:' || v_id);
    if v_msg is not null then
      update checkins set status = 'sent', outbound_message_id = v_msg, sent_at = now() where id = v_id;
    end if;
    n := n + 1;
  end loop;
  update checkins set status = 'no_reply'
   where status = 'sent' and reply_inbound_id is null and sent_at < now() - interval '3 days';
  return n;
end $$;

-- Staff start a check-in by hand (owner, doctor, coordinator).
create or replace function send_checkin(p_patient uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_clinic uuid; v_id uuid; v_msg uuid;
begin
  select clinic_id into v_clinic from patients where id = p_patient and deleted_at is null;
  if v_clinic is null or coalesce(my_role(v_clinic), '') not in ('owner','doctor','coordinator') then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  insert into checkins (clinic_id, patient_id, created_by) values (v_clinic, p_patient, auth.uid())
  returning id into v_id;
  v_msg := queue_patient_message(v_clinic, p_patient, 'comfort_checkin', 'checkin:' || v_id);
  if v_msg is not null then
    update checkins set status = 'sent', outbound_message_id = v_msg, sent_at = now() where id = v_id;
  end if;
  return v_id;
end $$;

-- Phone check-ins (or overriding a WhatsApp one): staff record the outcome themselves.
create or replace function record_checkin_outcome(p_checkin uuid, p_status text, p_note text default null)
returns void
language plpgsql as $$
declare k checkins;
begin
  if p_status not in ('ok','concern','cancelled') then raise exception 'outcome must be ok, concern or cancelled'; end if;
  select * into k from checkins where id = p_checkin;
  if not found then raise exception 'check-in not found'; end if;
  update checkins set status = p_status, staff_note = nullif(trim(p_note), ''),
         replied_at = coalesce(replied_at, now())
   where id = p_checkin;
  if not found then raise exception 'not permitted' using errcode = '42501'; end if;
  if p_status = 'concern' then
    perform raise_concern(k.patient_id, 'mild', coalesce(nullif(trim(p_note), ''), 'Raised at a check-in'), null, p_checkin);
  end if;
end $$;

-- =====================================================================
-- 20. Patient concerns (fed by #19 and by staff)
-- =====================================================================
create table patient_concerns (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  patient_id uuid not null,
  checkin_id uuid,
  inbound_message_id uuid references inbound_messages(id),
  severity text not null check (severity in ('urgent','mild','unclear')),
  topic text,
  summary text not null,
  source text not null default 'staff' check (source in ('staff','checkin','whatsapp')),
  assigned_to uuid references auth.users(id),
  status text not null default 'open' check (status in ('open','acknowledged','resolved')),
  outcome text,
  clinician_label text check (clinician_label in ('urgent','mild','fine')),  -- for classification agreement
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  acknowledged_at timestamptz,
  acknowledged_by uuid references auth.users(id),
  resolved_at timestamptz,
  resolved_by uuid references auth.users(id),
  foreign key (patient_id, clinic_id) references patients (id, clinic_id),
  foreign key (checkin_id, clinic_id) references checkins (id, clinic_id)
);
create index on patient_concerns (clinic_id, status, severity, created_at);

-- Any staff member can raise a concern (front desk takes calls). Assigned to the patient's clinician.
create or replace function raise_concern(
  p_patient uuid, p_severity text, p_summary text, p_inbound uuid default null, p_checkin uuid default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_clinic uuid; v_id uuid;
begin
  select clinic_id into v_clinic from patients where id = p_patient and deleted_at is null;
  if v_clinic is null then raise exception 'patient not found'; end if;
  if auth.uid() is not null and my_role(v_clinic) is null then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if p_severity not in ('urgent','mild','unclear') then raise exception 'severity must be urgent, mild or unclear'; end if;
  if coalesce(trim(p_summary), '') = '' then raise exception 'describe the concern'; end if;
  insert into patient_concerns (clinic_id, patient_id, checkin_id, inbound_message_id, severity, summary,
                                source, assigned_to, created_by)
  values (v_clinic, p_patient, p_checkin, p_inbound, p_severity, left(trim(p_summary), 1000),
          case when p_inbound is not null then 'whatsapp' when p_checkin is not null then 'checkin' else 'staff' end,
          clinician_for(p_patient), auth.uid())
  returning id into v_id;
  return v_id;
end $$;

create or replace function acknowledge_concern(p_concern uuid) returns void
language plpgsql as $$
begin
  update patient_concerns set status = 'acknowledged', acknowledged_at = now(), acknowledged_by = auth.uid()
   where id = p_concern and status = 'open';
  if not found then raise exception 'concern not found, already acknowledged, or not permitted'; end if;
end $$;

create or replace function resolve_concern(p_concern uuid, p_outcome text, p_clinician_label text default null)
returns void
language plpgsql as $$
begin
  if coalesce(trim(p_outcome), '') = '' then raise exception 'an outcome is required'; end if;
  if p_clinician_label is not null and p_clinician_label not in ('urgent','mild','fine') then
    raise exception 'label must be urgent, mild or fine';
  end if;
  update patient_concerns set status = 'resolved', outcome = trim(p_outcome),
         clinician_label = p_clinician_label, resolved_at = now(), resolved_by = auth.uid(),
         acknowledged_at = coalesce(acknowledged_at, now()), acknowledged_by = coalesce(acknowledged_by, auth.uid())
   where id = p_concern and status <> 'resolved';
  if not found then raise exception 'concern not found, already resolved, or not permitted'; end if;
end $$;

-- =====================================================================
-- 16 + 19. Inbound replies: link to an open check-in, then apply the classification
-- =====================================================================
drop function if exists record_inbound_message(uuid, text, text, text);
-- Server only. result: duplicate | stop | checkin_reply | reply | unknown_sender
create function record_inbound_message(
  p_clinic uuid, p_phone text, p_body text, p_provider_id text default null
) returns table (result text, inbound_id uuid, patient_id uuid, checkin_id uuid)
language plpgsql as $$
declare v_patient uuid; v_name text; v_inserted uuid; v_checkin uuid;
begin
  select p.id, p.full_name into v_patient, v_name from patients p
   where p.clinic_id = p_clinic and p.deleted_at is null
     and right(regexp_replace(p.phone, '\D', '', 'g'), 10) = right(regexp_replace(p_phone, '\D', '', 'g'), 10)
   order by p.created_at desc limit 1;

  insert into inbound_messages (clinic_id, patient_id, from_phone, body, provider_message_id)
  values (p_clinic, v_patient, p_phone, left(coalesce(p_body, ''), 2000), p_provider_id)
  on conflict (clinic_id, provider_message_id) where provider_message_id is not null do nothing
  returning id into v_inserted;
  if v_inserted is null then
    return query select 'duplicate'::text, null::uuid, v_patient, null::uuid; return;
  end if;

  if upper(trim(coalesce(p_body, ''))) in ('STOP','STOP ALL','UNSUBSCRIBE') then
    if v_patient is not null then
      insert into whatsapp_opt_events (clinic_id, patient_id, event, source)
      values (p_clinic, v_patient, 'opt_out', 'whatsapp_stop');
    end if;
    return query select 'stop'::text, v_inserted, v_patient, null::uuid; return;
  end if;

  if v_patient is null then
    return query select 'unknown_sender'::text, v_inserted, null::uuid, null::uuid; return;
  end if;

  select k.id into v_checkin from checkins k
   where k.patient_id = v_patient and k.clinic_id = p_clinic and k.status = 'sent'
     and k.reply_inbound_id is null and k.sent_at > now() - interval '7 days'
   order by k.sent_at desc limit 1;
  if v_checkin is not null then
    update checkins set reply_inbound_id = v_inserted, reply_text = left(p_body, 2000), replied_at = now()
     where id = v_checkin;
    return query select 'checkin_reply'::text, v_inserted, v_patient, v_checkin; return;
  end if;

  insert into tasks (clinic_id, assignee_id, patient_id, title, due_at, source)
  values (p_clinic, scan_task_owner(p_clinic), v_patient,
          'Reply to ' || v_name || ' on WhatsApp: "' || left(trim(p_body), 80) || '"', now(), 'system');
  return query select 'reply'::text, v_inserted, v_patient, null::uuid;
end $$;

-- Server only. Applies the AI or rule classification of a reply (#19).
-- Check-in replies: "fine" with confidence >= 0.8 closes the check-in as OK; anything else is a concern.
-- Other replies: only mild or urgent ones become concerns (the reply task already exists).
-- Urgent and low-confidence replies always reach a clinician.
create or replace function apply_reply_classification(
  p_inbound uuid, p_label text, p_topic text, p_confidence numeric, p_model text
) returns text
language plpgsql as $$
declare m inbound_messages; k checkins; v_label text; v_human boolean; v_sev text; v_name text;
begin
  select * into m from inbound_messages where id = p_inbound;
  if not found or m.patient_id is null then return 'ignored'; end if;
  v_label := case when p_label in ('fine','mild','urgent') then p_label else 'unknown' end;
  v_human := v_label <> 'fine' or coalesce(p_confidence, 0) < 0.8;
  v_sev := case v_label when 'urgent' then 'urgent' when 'mild' then 'mild' else 'unclear' end;
  select * into k from checkins where reply_inbound_id = p_inbound;

  insert into ai_actions (clinic_id, feature, patient_id, input_ref, draft, model)
  values (m.clinic_id, 'checkin_classification', m.patient_id,
          jsonb_build_object('inbound_message_id', p_inbound, 'checkin_id', k.id),
          jsonb_build_object('label', v_label, 'topic', p_topic, 'confidence', p_confidence)::text, p_model);

  select full_name into v_name from patients where id = m.patient_id;
  if k.id is not null then
    update checkins set classification = v_label, topic = p_topic, confidence = p_confidence,
           status = case when v_human then 'concern' else 'ok' end
     where id = k.id;
    if v_human then
      perform raise_concern(m.patient_id, v_sev, 'Check-in reply: "' || left(m.body, 300) || '"', p_inbound, k.id);
      update patient_concerns set topic = p_topic where inbound_message_id = p_inbound;
      return 'concern';
    end if;
    return 'ok';
  end if;
  if v_label in ('urgent','mild') then
    perform raise_concern(m.patient_id, v_sev, 'WhatsApp message: "' || left(m.body, 300) || '"', p_inbound, null);
    update patient_concerns set topic = p_topic where inbound_message_id = p_inbound;
    return 'concern';
  end if;
  return 'ok';
end $$;

-- =====================================================================
-- 17 + 18. AI platform: switches, knowledge base, draft review
-- =====================================================================
alter table clinics add column ai_enabled boolean not null default true;
alter table clinics add column ai_features jsonb not null default
  '{"enquiry_reply": true, "checkin_classification": true, "plan_explainer": true, "weekly_summary": true}';
alter table clinics add column opening_hours jsonb not null default
  '{"days": [1,2,3,4,5,6], "open": "10:00", "close": "19:00"}';
alter table clinics add column slot_minutes int not null default 30 check (slot_minutes between 10 and 120);

alter table ai_actions add column confidence numeric;
alter table ai_actions add column grounded boolean;     -- false when no approved content matched
alter table ai_actions add column subject_id uuid;      -- the enquiry, plan, etc. the draft is for
create index on ai_actions (clinic_id, feature, created_at);

-- What the clinic is happy for drafts to say. Owner approves the content (roadmap: Phase 1 AI rollout).
create table clinic_faqs (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  question text not null,
  answer text not null,
  keywords text[] not null default '{}',
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create table clinic_price_ranges (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  treatment text not null,
  min_inr int not null check (min_inr >= 0),
  max_inr int not null,
  note text,
  active boolean not null default true,
  check (max_inr >= min_inr),
  unique (clinic_id, treatment)
);

alter table enquiries add column message text;
alter table enquiries add column preferred_language text not null default 'en';

-- Staff approve, edit or discard a draft. Nothing is sent without this. Clinical drafts need a clinician.
create or replace function review_ai_draft(p_action uuid, p_final_text text, p_outcome text) returns void
language plpgsql security definer set search_path = public as $$
declare a ai_actions; v_role text;
begin
  select * into a from ai_actions where id = p_action;
  if not found then raise exception 'draft not found'; end if;
  v_role := my_role(a.clinic_id);
  if v_role is null then raise exception 'not permitted' using errcode = '42501'; end if;
  if a.feature = 'plan_explainer' and v_role not in ('owner','doctor') then
    raise exception 'a clinician must approve a plan explainer' using errcode = '42501';
  end if;
  if a.outcome <> 'pending' then raise exception 'this draft was already reviewed'; end if;
  if p_outcome not in ('sent','edited_sent','discarded') then raise exception 'invalid outcome'; end if;
  if p_outcome <> 'discarded' and coalesce(trim(p_final_text), '') = '' then
    raise exception 'the message is empty';
  end if;
  update ai_actions set reviewer_id = auth.uid(), reviewed_at = now(), outcome = p_outcome,
         final_text = case when p_outcome = 'discarded' then null else left(p_final_text, 4000) end
   where id = p_action;
end $$;

-- Acceptance and edit rates per feature (pilot criterion: tracked, no target yet).
create or replace view ai_draft_stats with (security_invoker = true) as
select clinic_id, feature,
       count(*) filter (where outcome = 'sent')        as sent_as_is,
       count(*) filter (where outcome = 'edited_sent') as edited,
       count(*) filter (where outcome = 'discarded')   as discarded,
       count(*) filter (where outcome = 'pending')     as pending
  from ai_actions where feature <> 'checkin_classification'
 group by clinic_id, feature;

-- Classification agreement: what the AI said against the clinician's label when the concern was resolved.
create or replace view classification_agreement with (security_invoker = true) as
select c.clinic_id, k.classification as ai_label, c.clinician_label, count(*) as n
  from patient_concerns c join checkins k on k.id = c.checkin_id
 where c.clinician_label is not null and k.classification is not null
 group by 1, 2, 3;

-- =====================================================================
-- 21. No-show and lapsed-patient recovery
-- =====================================================================
alter table clinics add column lapsed_after_days int not null default 45 check (lapsed_after_days between 7 and 365);

create table recalls (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  patient_id uuid not null,
  kind text not null check (kind in ('no_show','lapsed')),
  appointment_id uuid,
  status text not null default 'open' check (status in ('open','booked','closed')),
  attempts int not null default 0,
  next_attempt_at timestamptz not null default now(),
  reason text,
  created_at timestamptz not null default now(),
  closed_at timestamptz,
  closed_by uuid references auth.users(id),
  foreign key (patient_id, clinic_id) references patients (id, clinic_id),
  foreign key (appointment_id, clinic_id) references appointments (id, clinic_id)
);
create unique index recalls_one_open on recalls (clinic_id, patient_id) where status = 'open';

-- A no-show opens a recall; any new booking for the patient closes it as recovered.
create or replace function appointments_recall_sync() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' and new.status = 'no_show' and old.status is distinct from 'no_show' then
    insert into recalls (clinic_id, patient_id, kind, appointment_id, next_attempt_at)
    values (new.clinic_id, new.patient_id, 'no_show', new.id, now() + interval '2 hours')
    on conflict do nothing;
  elsif tg_op = 'INSERT' and new.status = 'booked' and new.starts_at > now() then
    update recalls set status = 'booked', closed_at = now(), reason = coalesce(reason, 'rebooked')
     where patient_id = new.patient_id and clinic_id = new.clinic_id and status = 'open';
  end if;
  return new;
end $$;
create trigger appointments_recall_sync after insert or update of status on appointments
  for each row execute function appointments_recall_sync();

-- Server only. Active treatment, nothing booked ahead, no visit for lapsed_after_days.
create or replace function enqueue_lapsed_recalls() returns int
language plpgsql as $$
declare n int;
begin
  insert into recalls (clinic_id, patient_id, kind)
  select distinct pt.clinic_id, pt.patient_id, 'lapsed'
    from patient_treatments pt
    join clinics c on c.id = pt.clinic_id
    join patients p on p.id = pt.patient_id and p.deleted_at is null
   where pt.status = 'active'
     and coalesce(pt.started_at, now()) < now() - make_interval(days => c.lapsed_after_days)
     and not exists (select 1 from appointments a where a.patient_id = pt.patient_id
                       and a.status = 'booked' and a.starts_at > now())
     and not exists (select 1 from appointments a where a.patient_id = pt.patient_id
                       and a.status in ('arrived','completed')
                       and a.starts_at > now() - make_interval(days => c.lapsed_after_days))
  on conflict do nothing;
  get diagnostics n = row_count;
  return n;
end $$;

-- Server only. Up to three attempts (now, +6 days, +14 days): WhatsApp when possible, else a call task.
create or replace function run_recall_sequences() returns int
language plpgsql as $$
declare r record; n int := 0; v_msg uuid; v_attempt int;
begin
  for r in
    select rc.*, p.full_name from recalls rc join patients p on p.id = rc.patient_id
     where rc.status = 'open' and rc.next_attempt_at <= now() and rc.attempts < 3
     for update of rc skip locked
  loop
    v_attempt := r.attempts + 1;
    v_msg := queue_patient_message(r.clinic_id, r.patient_id,
               case r.kind when 'no_show' then 'no_show_recall' else 'lapsed_recall' end,
               'recall:' || r.id || ':' || v_attempt);
    if v_msg is null or v_attempt = 3 then
      insert into tasks (clinic_id, assignee_id, patient_id, title, due_at, source)
      values (r.clinic_id, scan_task_owner(r.clinic_id), r.patient_id,
              case when v_attempt = 3 then 'Last recall attempt: call ' else 'Call ' end || r.full_name ||
              case r.kind when 'no_show' then ' about the missed appointment' else ' to book their next visit' end,
              now(), 'system');
    end if;
    update recalls set attempts = v_attempt,
           next_attempt_at = now() + case v_attempt when 1 then interval '6 days' else interval '14 days' end
     where id = r.id;
    n := n + 1;
  end loop;
  return n;
end $$;

create or replace function close_recall(p_recall uuid, p_reason text) returns void
language plpgsql as $$
begin
  if coalesce(trim(p_reason), '') = '' then raise exception 'a reason is required'; end if;
  update recalls set status = 'closed', reason = left(trim(p_reason), 300), closed_at = now(), closed_by = auth.uid()
   where id = p_recall and status = 'open';
  if not found then raise exception 'recall not found, already closed, or not permitted'; end if;
end $$;

-- =====================================================================
-- 22. Instalments, receipts and invoices (GST-ready; format to confirm with the accountant)
-- =====================================================================
alter table clinics add column legal_name text;
alter table clinics add column gstin text check (gstin is null or gstin ~ '^[0-9]{2}[A-Z0-9]{10}[0-9A-Z]Z[0-9A-Z]$');
alter table clinics add column address text;
alter table clinics add column invoice_prefix text not null default 'INV'
  check (invoice_prefix ~ '^[A-Z]{2,4}$' and invoice_prefix <> 'RCT');
alter table clinics add column gst_rate_bps int not null default 0 check (gst_rate_bps between 0 and 2800);
alter table clinics add column sac_code text;

alter table payments add column instalment_no int;
alter table payments add column method text;
alter table payments add column created_at timestamptz not null default now();
alter table payments add column reminder_queued_at timestamptz;
alter table payments add constraint payments_amount_positive check (amount_paise > 0) not valid;

alter table invoices add column kind text not null default 'invoice' check (kind in ('invoice','receipt'));
alter table invoices add column patient_treatment_id uuid;
alter table invoices add column method text;
alter table invoices add column taxable_paise bigint;
alter table invoices add column seller jsonb not null default '{}';   -- snapshot: legal name, GSTIN, address, SAC, rate
alter table invoices add column buyer_name text;
alter table invoices add column description text;
alter table invoices add constraint invoices_treatment_same_clinic
  foreign key (patient_treatment_id, clinic_id) references patient_treatments (id, clinic_id);

create table document_counters (
  clinic_id uuid not null references clinics(id) on delete cascade,
  fy text not null,
  kind text not null,
  last int not null default 0,
  primary key (clinic_id, fy, kind)
);
alter table document_counters enable row level security;  -- no policies: only the function below writes

-- Indian financial year in the clinic's time zone, e.g. 2026-27.
create or replace function financial_year(p_day date) returns text
language sql immutable as $$
  select case when extract(month from p_day) >= 4
              then extract(year from p_day)::int || '-' || lpad(((extract(year from p_day)::int + 1) % 100)::text, 2, '0')
              else (extract(year from p_day)::int - 1) || '-' || lpad((extract(year from p_day)::int % 100)::text, 2, '0') end
$$;

-- Gap-free, per financial year, at most 16 characters (e.g. INV/2026-27/0001).
create or replace function next_document_number(p_clinic uuid, p_kind text) returns text
language plpgsql security definer set search_path = public as $$
declare v_fy text; v_n int; v_prefix text;
begin
  if coalesce(my_role(p_clinic), '') not in ('owner','coordinator') then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  v_fy := financial_year(clinic_today(p_clinic));
  insert into document_counters (clinic_id, fy, kind, last) values (p_clinic, v_fy, p_kind, 1)
  on conflict (clinic_id, fy, kind) do update set last = document_counters.last + 1
  returning last into v_n;
  select case when p_kind = 'receipt' then 'RCT' else invoice_prefix end into v_prefix from clinics where id = p_clinic;
  return v_prefix || '/' || v_fy || '/' || lpad(v_n::text, 4, '0');
end $$;

create or replace function seller_snapshot(p_clinic uuid) returns jsonb
language sql stable as $$
  select jsonb_build_object('name', coalesce(legal_name, name), 'gstin', gstin, 'address', address,
                            'sac', sac_code, 'gst_rate_bps', gst_rate_bps)
    from clinics where id = p_clinic
$$;

-- Replaces unpaid instalments with a new equal-split schedule. Already-paid instalments stay.
create or replace function create_instalment_plan(
  p_treatment uuid, p_total_paise bigint, p_count int, p_first_due date, p_every_days int default 30
) returns int
language plpgsql as $$
declare t patient_treatments; v_paid bigint; v_left bigint; v_each bigint; i int; v_base int;
begin
  select * into t from patient_treatments where id = p_treatment;
  if not found then raise exception 'treatment not found'; end if;
  if coalesce(my_role(t.clinic_id), '') not in ('owner','coordinator') then
    raise exception 'only the owner or a coordinator can set up payments' using errcode = '42501';
  end if;
  if p_total_paise is null or p_total_paise <= 0 then raise exception 'enter the treatment cost'; end if;
  if p_count is null or p_count < 1 or p_count > 36 then raise exception 'between 1 and 36 instalments'; end if;
  if p_every_days is null or p_every_days < 1 or p_every_days > 180 then raise exception 'interval must be 1 to 180 days'; end if;

  delete from payments where patient_treatment_id = p_treatment and paid_at is null and coalesce(paid_amount_paise, 0) = 0;
  select coalesce(sum(coalesce(paid_amount_paise, 0)), 0), coalesce(max(instalment_no), 0)
    into v_paid, v_base from payments where patient_treatment_id = p_treatment;
  v_left := p_total_paise - v_paid;
  if v_left <= 0 then raise exception 'the treatment is already paid in full'; end if;
  -- Round each instalment down to whole rupees; the last one takes the remainder.
  v_each := (v_left / p_count / 100) * 100;
  for i in 1..p_count loop
    insert into payments (clinic_id, patient_treatment_id, amount_paise, due_date, instalment_no)
    values (t.clinic_id, p_treatment,
            case when i = p_count then v_left - v_each * (p_count - 1) else v_each end,
            p_first_due + (i - 1) * p_every_days, v_base + i);
  end loop;
  update patient_treatments set total_cost_paise = p_total_paise where id = p_treatment;
  return p_count;
end $$;

-- Records money received against an instalment and issues a numbered receipt. Returns the receipt id.
create or replace function record_payment(
  p_payment uuid, p_amount_paise bigint, p_method text, p_at timestamptz default now()
) returns uuid
language plpgsql as $$
declare p payments; t patient_treatments; v_left bigint; v_rate int; v_tax bigint; v_id uuid; v_name text;
begin
  select * into p from payments where id = p_payment;
  if not found then raise exception 'instalment not found'; end if;
  if coalesce(my_role(p.clinic_id), '') not in ('owner','coordinator') then
    raise exception 'only the owner or a coordinator can record payments' using errcode = '42501';
  end if;
  if p_method not in ('cash','upi','card','bank_transfer','cheque','other') then raise exception 'choose a payment method'; end if;
  v_left := p.amount_paise - coalesce(p.paid_amount_paise, 0);
  if v_left <= 0 then raise exception 'this instalment is already paid'; end if;
  if p_amount_paise is null or p_amount_paise <= 0 or p_amount_paise > v_left then
    raise exception 'amount must be between ₹0.01 and the ₹% still due', round(v_left / 100.0, 2);
  end if;

  update payments set paid_amount_paise = coalesce(paid_amount_paise, 0) + p_amount_paise, method = p_method,
         paid_at = case when coalesce(paid_amount_paise, 0) + p_amount_paise >= amount_paise then p_at else paid_at end
   where id = p_payment;

  select * into t from patient_treatments where id = p.patient_treatment_id;
  select full_name into v_name from patients where id = t.patient_id;
  select gst_rate_bps into v_rate from clinics where id = p.clinic_id;
  v_tax := round(p_amount_paise * v_rate::numeric / (10000 + v_rate));   -- tax included in the amount
  insert into invoices (clinic_id, patient_id, payment_id, patient_treatment_id, kind, number, issued_at,
                        amount_paise, tax_paise, taxable_paise, method, seller, buyer_name, description)
  values (p.clinic_id, t.patient_id, p.id, t.id, 'receipt', next_document_number(p.clinic_id, 'receipt'), p_at,
          p_amount_paise, v_tax, p_amount_paise - v_tax, p_method, seller_snapshot(p.clinic_id), v_name,
          'Instalment ' || coalesce(p.instalment_no::text, '') || ' for treatment')
  returning id into v_id;
  return v_id;
end $$;

-- One invoice for the treatment cost, issued once.
create or replace function issue_treatment_invoice(p_treatment uuid, p_description text default null) returns uuid
language plpgsql as $$
declare t patient_treatments; v_rate int; v_tax bigint; v_id uuid; v_name text;
begin
  select * into t from patient_treatments where id = p_treatment;
  if not found then raise exception 'treatment not found'; end if;
  if coalesce(my_role(t.clinic_id), '') not in ('owner','coordinator') then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if coalesce(t.total_cost_paise, 0) <= 0 then raise exception 'set the treatment cost first'; end if;
  if exists (select 1 from invoices where patient_treatment_id = p_treatment and kind = 'invoice' and status = 'issued') then
    raise exception 'an invoice was already issued for this treatment';
  end if;
  select gst_rate_bps into v_rate from clinics where id = t.clinic_id;
  select full_name into v_name from patients where id = t.patient_id;
  v_tax := round(t.total_cost_paise * v_rate::numeric / (10000 + v_rate));
  insert into invoices (clinic_id, patient_id, patient_treatment_id, kind, number, amount_paise, tax_paise,
                        taxable_paise, seller, buyer_name, description)
  values (t.clinic_id, t.patient_id, t.id, 'invoice', next_document_number(t.clinic_id, 'invoice'),
          t.total_cost_paise, v_tax, t.total_cost_paise - v_tax, seller_snapshot(t.clinic_id), v_name,
          coalesce(nullif(trim(p_description), ''), 'Orthodontic treatment'))
  returning id into v_id;
  return v_id;
end $$;

-- Server only. One WhatsApp reminder per overdue instalment (template payment_reminder: {{3}} amount, {{4}} due date).
create or replace function enqueue_payment_reminders() returns int
language plpgsql as $$
declare r record; n int := 0;
begin
  for r in
    select p.id, p.clinic_id, pt.patient_id, p.amount_paise - coalesce(p.paid_amount_paise, 0) as due, p.due_date
      from payments p join patient_treatments pt on pt.id = p.patient_treatment_id
     where p.paid_at is null and p.reminder_queued_at is null and p.due_date < clinic_today(p.clinic_id)
  loop
    perform queue_patient_message(r.clinic_id, r.patient_id, 'payment_reminder', 'payment:' || r.id,
      jsonb_build_array('₹' || to_char(r.due / 100.0, 'FM99,99,99,990.00'), to_char(r.due_date, 'DD Mon YYYY')));
    update payments set reminder_queued_at = now() where id = r.id;
    n := n + 1;
  end loop;
  return n;
end $$;

-- =====================================================================
-- 23. Emergency visits: logged without moving the SOP unless a clinician links them
-- =====================================================================
alter table appointments add column reason text;

create or replace function log_emergency_visit(p_patient uuid, p_reason text, p_doctor uuid default null)
returns uuid
language plpgsql as $$
declare v_clinic uuid; v_id uuid;
begin
  select clinic_id into v_clinic from patients where id = p_patient and deleted_at is null;
  if v_clinic is null then raise exception 'patient not found'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'say why the patient came in'; end if;
  insert into appointments (clinic_id, patient_id, doctor_id, starts_at, ends_at, status, visit_type, reason)
  values (v_clinic, p_patient, p_doctor, now(), now() + interval '30 minutes', 'arrived', 'emergency',
          left(trim(p_reason), 500))
  returning id into v_id;
  return v_id;
end $$;

-- A clinician decides the emergency visit counted as the next SOP step.
create or replace function link_visit_to_step(p_appointment uuid, p_step uuid) returns void
language plpgsql as $$
declare a appointments; s treatment_steps;
begin
  select * into a from appointments where id = p_appointment;
  select * into s from treatment_steps where id = p_step;
  if a.id is null or s.id is null or a.clinic_id <> s.clinic_id then raise exception 'visit or step not found'; end if;
  if coalesce(my_role(a.clinic_id), '') not in ('owner','doctor') then
    raise exception 'only a clinician can link a visit to a step' using errcode = '42501';
  end if;
  if a.status not in ('arrived','completed') then raise exception 'the patient must have attended'; end if;
  perform advance_step(p_step, 'done', a.starts_at);
  update treatment_steps set appointment_id = p_appointment where id = p_step;
end $$;

-- Optional after an emergency: move the next step's due date (a clinician decision).
create or replace function shift_next_step(p_treatment uuid, p_days int) returns void
language plpgsql as $$
declare v_step uuid; v_clinic uuid;
begin
  select clinic_id into v_clinic from patient_treatments where id = p_treatment and status = 'active';
  if v_clinic is null then raise exception 'active treatment not found'; end if;
  if coalesce(my_role(v_clinic), '') not in ('owner','doctor') then
    raise exception 'only a clinician can change the schedule' using errcode = '42501';
  end if;
  if p_days is null or p_days = 0 or abs(p_days) > 90 then raise exception 'shift by 1 to 90 days'; end if;
  select id into v_step from treatment_steps
   where patient_treatment_id = p_treatment and status = 'pending' order by position limit 1;
  if v_step is null then raise exception 'no pending step'; end if;
  update treatment_steps set due_at = due_at + make_interval(days => p_days) where id = v_step;
end $$;

-- =====================================================================
-- 24. Owner dashboard (one period; the page calls it twice to compare)
-- =====================================================================
create or replace function owner_dashboard(p_from date, p_to date)
returns table (
  leads bigint, contacted bigint, consults_booked bigint, consults_attended bigint, plans_offered bigint,
  cases_started bigint, replied_within_sla bigint, median_reply_minutes numeric,
  visits bigint, unique_patients bigint, new_patient_visits bigint, walk_ins bigint,
  no_shows bigint, no_shows_recovered bigint, appointments_held bigint,
  active_treatments bigint, delayed_cases bigint,
  billed_paise bigint, collected_paise bigint, overdue_paise bigint, pending_paise bigint,
  patients_registered bigint, patients_with_source bigint
)
language sql stable as $$
  with c as (select id, timezone, reply_sla_minutes from clinics where id in (select my_clinic_ids()) limit 1),
  e as (select en.* from enquiries en, c where en.clinic_id = c.id
          and (en.received_at at time zone c.timezone)::date between p_from and p_to),
  a as (select ap.* from appointments ap, c where ap.clinic_id = c.id
          and (ap.starts_at at time zone c.timezone)::date between p_from and p_to)
  select
    (select count(*) from e),
    (select count(*) from e where first_replied_at is not null),
    (select count(*) from e where consult_booked_at is not null),
    (select count(*) from e where consult_attended_at is not null),
    (select count(*) from e where plan_offered_at is not null),
    (select count(*) from e where case_started_at is not null),
    (select count(*) from e, c where first_replied_at <= received_at + make_interval(mins => c.reply_sla_minutes)),
    (select round((percentile_cont(0.5) within group (order by extract(epoch from first_replied_at - received_at) / 60))::numeric, 0)
       from e where first_replied_at is not null),
    (select count(*) from a where status in ('arrived','completed')),
    (select count(distinct patient_id) from a where status in ('arrived','completed')),
    (select count(*) from a where status in ('arrived','completed') and visit_type = 'new'),
    (select count(*) from a where status in ('arrived','completed') and visit_type = 'walkin'),
    (select count(*) from a where status = 'no_show'),
    (select count(*) from recalls r join a on a.id = r.appointment_id where r.kind = 'no_show' and r.status = 'booked'),
    (select count(*) from a where status in ('arrived','completed','no_show')),
    (select count(*) from patient_treatments pt, c where pt.clinic_id = c.id and pt.status = 'active'),
    (select count(distinct patient_treatment_id) from delayed_steps ds, c where ds.clinic_id = c.id),
    (select coalesce(sum(amount_paise), 0)::bigint from invoices i, c where i.clinic_id = c.id and i.kind = 'invoice'
       and i.status = 'issued' and (i.issued_at at time zone c.timezone)::date between p_from and p_to),
    (select coalesce(sum(amount_paise), 0)::bigint from invoices i, c where i.clinic_id = c.id and i.kind = 'receipt'
       and i.status = 'issued' and (i.issued_at at time zone c.timezone)::date between p_from and p_to),
    (select coalesce(sum(amount_paise - coalesce(paid_amount_paise, 0)), 0)::bigint from payments p, c
      where p.clinic_id = c.id and p.paid_at is null and p.due_date < clinic_today(c.id)),
    (select coalesce(sum(amount_paise - coalesce(paid_amount_paise, 0)), 0)::bigint from payments p, c
      where p.clinic_id = c.id and p.paid_at is null),
    (select count(*) from patients p, c where p.clinic_id = c.id and p.deleted_at is null
       and (p.created_at at time zone c.timezone)::date between p_from and p_to),
    (select count(*) from patients p, c where p.clinic_id = c.id and p.deleted_at is null and p.lead_source is not null
       and (p.created_at at time zone c.timezone)::date between p_from and p_to)
$$;

-- =====================================================================
-- 25. Today queue: more item kinds, and inputs for rule-based ranking
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
) q;

-- =====================================================================
-- 26. Rule-based drop-off risk flags (readable rules; ML is later, #54)
-- =====================================================================
create or replace view dropoff_flags with (security_invoker = true) as
with active as (
  select distinct on (pt.patient_id) pt.clinic_id, pt.patient_id, pt.id as treatment_id
    from patient_treatments pt where pt.status = 'active' order by pt.patient_id, pt.started_at desc
), f as (
  select ac.clinic_id, ac.patient_id, ac.treatment_id,
    (select count(*) from appointments a where a.patient_id = ac.patient_id and a.status = 'no_show'
       and a.starts_at > now() - interval '90 days')::int as missed_visits,
    (select count(*) from checkins k where k.patient_id = ac.patient_id and k.status = 'no_reply'
       and k.created_at > now() - interval '90 days')::int as unanswered_checkins,
    coalesce((select max(extract(day from now() - ds.due_at))::int from delayed_steps ds
       where ds.patient_treatment_id = ac.treatment_id), 0) as days_behind
  from active ac
)
select f.*, p.full_name,
       array_remove(array[
         case when f.missed_visits >= 2 then 'Missed ' || f.missed_visits || ' visits in the last 90 days' end,
         case when f.unanswered_checkins >= 2 then 'Did not answer ' || f.unanswered_checkins || ' check-ins in the last 90 days' end,
         case when f.days_behind >= 14 then f.days_behind || ' days behind the SOP schedule' end
       ], null) as reasons
  from f join patients p on p.id = f.patient_id and p.deleted_at is null
 where f.missed_visits >= 2 or f.unanswered_checkins >= 2 or f.days_behind >= 14;

-- =====================================================================
-- 27. Usage analytics (no patient data) and pilot success metrics
-- =====================================================================
create table usage_events (
  id bigserial primary key,
  clinic_id uuid not null references clinics(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null,
  event text not null check (event ~ '^[a-z_]{2,40}$'),
  path text check (path is null or path ~ '^/[a-z0-9/_\[\]-]{0,80}$'),   -- route pattern, ids replaced
  at timestamptz not null default now()
);
create index on usage_events (clinic_id, at);

create or replace function track_usage(p_event text, p_path text default null) returns void
language plpgsql security definer set search_path = public as $$
declare v_clinic uuid; v_role text;
begin
  select clinic_id, role into v_clinic, v_role from clinic_members where user_id = auth.uid() and active limit 1;
  if v_clinic is null then return; end if;
  insert into usage_events (clinic_id, user_id, role, event, path) values (v_clinic, auth.uid(), v_role, p_event, p_path);
end $$;

create or replace function pilot_metrics(p_from date, p_to date)
returns table (
  median_first_reply_minutes numeric, active_treatments bigint, on_track bigint,
  owner_open_days bigint, working_days bigint,
  enquiries bigint, patients_registered bigint, patients_with_source bigint,
  no_shows bigint, appointments_held bigint,
  messages_sent bigint, messages_delivered bigint,
  urgent_concerns bigint, urgent_median_minutes_to_action numeric
)
language sql stable as $$
  with c as (select id, timezone from clinics where id in (select my_clinic_ids()) limit 1)
  select
    d.median_reply_minutes,
    d.active_treatments,
    d.active_treatments - d.delayed_cases,
    (select count(distinct (u.at at time zone c.timezone)::date) from usage_events u, c
      where u.clinic_id = c.id and u.role = 'owner' and (u.at at time zone c.timezone)::date between p_from and p_to),
    (select count(*) from generate_series(p_from, p_to, interval '1 day') g where extract(isodow from g) < 7),
    d.leads, d.patients_registered, d.patients_with_source,
    d.no_shows, d.appointments_held,
    (select count(*) from outbound_messages o, c where o.clinic_id = c.id and o.status in ('sent','delivered','read','failed')
       and (o.created_at at time zone c.timezone)::date between p_from and p_to),
    (select count(*) from outbound_messages o, c where o.clinic_id = c.id and o.status in ('delivered','read')
       and (o.created_at at time zone c.timezone)::date between p_from and p_to),
    (select count(*) from patient_concerns pc, c where pc.clinic_id = c.id and pc.severity = 'urgent'
       and (pc.created_at at time zone c.timezone)::date between p_from and p_to),
    (select round((percentile_cont(0.5) within group (order by extract(epoch from pc.acknowledged_at - pc.created_at) / 60))::numeric, 0)
       from patient_concerns pc, c where pc.clinic_id = c.id and pc.severity = 'urgent' and pc.acknowledged_at is not null
       and (pc.created_at at time zone c.timezone)::date between p_from and p_to)
  from owner_dashboard(p_from, p_to) d
$$;

-- =====================================================================
-- RLS, 2FA, audit, grants
-- =====================================================================
do $$
declare t text;
begin
  foreach t in array array['patient_imports','checkins','patient_concerns','clinic_faqs','clinic_price_ranges',
                           'recalls','usage_events'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy mfa_required on %I as restrictive for all to authenticated
                    using ((select mfa_ok())) with check ((select mfa_ok()))', t);
  end loop;
  foreach t in array array['patient_imports','checkins','patient_concerns','clinic_faqs','clinic_price_ranges','recalls'] loop
    execute format('create trigger audit_%1$s after insert or update or delete on %1$s
                    for each row execute function audit_row()', t);
  end loop;
end $$;

create policy imports_read on patient_imports for select using (my_role(clinic_id) in ('owner','coordinator'));
create policy imports_insert on patient_imports for insert with check (my_role(clinic_id) in ('owner','coordinator'));
create policy imports_update on patient_imports for update
  using (my_role(clinic_id) in ('owner','coordinator')) with check (my_role(clinic_id) in ('owner','coordinator'));

-- Check-ins and concerns are clinical: front desk raises concerns through raise_concern() only.
create policy checkins_read on checkins for select using (my_role(clinic_id) in ('owner','doctor','coordinator'));
create policy checkins_update on checkins for update
  using (my_role(clinic_id) in ('owner','doctor','coordinator'))
  with check (my_role(clinic_id) in ('owner','doctor','coordinator'));
create policy concerns_read on patient_concerns for select using (my_role(clinic_id) in ('owner','doctor','coordinator'));
create policy concerns_update on patient_concerns for update
  using (my_role(clinic_id) in ('owner','doctor','coordinator'))
  with check (my_role(clinic_id) in ('owner','doctor','coordinator'));

-- Knowledge base: all staff read (drafts are used by front desk), owner writes.
create policy faqs_read on clinic_faqs for select using (clinic_id in (select my_clinic_ids()));
create policy faqs_write on clinic_faqs for all using (my_role(clinic_id) = 'owner') with check (my_role(clinic_id) = 'owner');
create policy prices_read on clinic_price_ranges for select using (clinic_id in (select my_clinic_ids()));
create policy prices_write on clinic_price_ranges for all using (my_role(clinic_id) = 'owner') with check (my_role(clinic_id) = 'owner');

-- Recalls: front desk makes the calls, so all staff read and close them. Opened by triggers and the worker.
create policy recalls_read on recalls for select using (clinic_id in (select my_clinic_ids()));
create policy recalls_update on recalls for update
  using (clinic_id in (select my_clinic_ids())) with check (clinic_id in (select my_clinic_ids()));

create policy usage_owner_read on usage_events for select using (my_role(clinic_id) = 'owner');

-- Front desk can now see enquiry-reply drafts (they answer enquiries); clinical AI records stay clinical.
create policy ai_read_front_desk on ai_actions for select
  using (my_role(clinic_id) = 'front_desk' and feature = 'enquiry_reply');

-- Server only
do $$
declare f text;
begin
  foreach f in array array[
    'queue_patient_message(uuid,uuid,text,text,jsonb,timestamptz)', 'clinician_for(uuid)',
    'enqueue_checkins()', 'record_inbound_message(uuid,text,text,text)',
    'apply_reply_classification(uuid,text,text,numeric,text)', 'enqueue_lapsed_recalls()',
    'run_recall_sequences()', 'enqueue_payment_reminders()'
  ] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;
revoke execute on function track_usage(text, text) from public, anon;
-- raise_concern trusts a missing auth.uid() as the server, so anonymous callers must not reach it.
revoke execute on function raise_concern(uuid, text, text, uuid, uuid) from public, anon;
grant execute on function raise_concern(uuid, text, text, uuid, uuid) to authenticated, service_role;
