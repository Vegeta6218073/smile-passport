-- Automation: the pieces a background worker and the WhatsApp webhook need.
-- Every function below is for the SERVER only (service role). Staff and anonymous users cannot call them.
--   1 scan deadline alerts   2 outbound message queue (claim, sent, failed, delivery status)
--   3 inbound WhatsApp messages (replies logged, STOP opts the patient out)

alter table smile_scans add column deadline_alerted_at timestamptz;
alter table outbound_messages add column attempts int not null default 0;
alter table outbound_messages add column locked_at timestamptz;   -- set while a worker is sending it
create index on outbound_messages (provider_message_id) where provider_message_id is not null;
create unique index inbound_provider_id_key on inbound_messages (clinic_id, provider_message_id)
  where provider_message_id is not null;                          -- a replayed webhook adds nothing

-- ---------- 1. Smile scan deadline alerts ----------
-- One task per scan, created when its 24h review deadline is within p_within (or already past).
create or replace function enqueue_scan_deadline_alerts(p_within interval default interval '4 hours')
returns int
language plpgsql as $$
declare r smile_scans; n int := 0; v_assignee uuid;
begin
  for r in
    select * from smile_scans
     where status in ('submitted','in_review') and deadline_alerted_at is null
       and review_due_at <= now() + p_within
       for update skip locked
  loop
    v_assignee := coalesce(
      r.reviewer_id,
      (select user_id from clinic_members
        where clinic_id = r.clinic_id and active and role = 'doctor' order by created_at limit 1),
      scan_task_owner(r.clinic_id));
    insert into tasks (clinic_id, assignee_id, title, due_at, source)
    values (r.clinic_id, v_assignee,
            'Smile scan due ' || case when r.review_due_at < now() then 'now (overdue)' else 'soon' end
              || ': ' || r.full_name,
            r.review_due_at, 'system');
    update smile_scans set deadline_alerted_at = now() where id = r.id;
    n := n + 1;
  end loop;
  return n;
end $$;

-- ---------- 2. Outbound queue ----------
-- Hands a worker up to p_limit due messages and locks them for 5 minutes. Two workers never get the same row.
create or replace function claim_outbound_batch(p_limit int default 20)
returns setof outbound_messages
language sql as $$
  update outbound_messages m set locked_at = now(), attempts = m.attempts + 1
   where m.id in (
     select id from outbound_messages
      where status = 'queued' and scheduled_for <= now() and attempts < 5
        and (locked_at is null or locked_at < now() - interval '5 minutes')
      order by scheduled_for limit p_limit
      for update skip locked)
  returning m.*
$$;

-- Returns the final status. The opt-in gate trigger may turn 'sent' into 'blocked_no_opt_in'.
create or replace function mark_outbound_sent(p_id uuid, p_provider_id text) returns text
language plpgsql as $$
declare v_status text;
begin
  update outbound_messages
     set status = 'sent', provider_message_id = p_provider_id, sent_at = now(), locked_at = null
   where id = p_id and status = 'queued'
   returning status into v_status;
  return v_status;
end $$;

-- Retryable failures go back in the queue with a growing delay; after 5 attempts (or a permanent error) it is failed.
create or replace function mark_outbound_failed(p_id uuid, p_error text, p_retry boolean default true)
returns void
language sql as $$
  update outbound_messages set
    error = left(coalesce(p_error, 'unknown error'), 500),
    locked_at = null,
    status = case when p_retry and attempts < 5 then 'queued' else 'failed' end,
    scheduled_for = case when p_retry and attempts < 5
                         then now() + (attempts * interval '5 minutes') else scheduled_for end
  where id = p_id and status = 'queued'
$$;

-- Delivery receipts only move a message forward (sent, delivered, read); 'failed' always wins.
create or replace function record_delivery_status(
  p_provider_id text, p_status text, p_at timestamptz default now(), p_error text default null
) returns void
language plpgsql as $$
declare v_order text[] := array['queued','sent','delivered','read'];
begin
  if p_status not in ('sent','delivered','read','failed') then return; end if;
  update outbound_messages set
    status = case
      when p_status = 'failed' then 'failed'
      when array_position(v_order, p_status) > coalesce(array_position(v_order, status), 99) then p_status
      else status end,
    delivered_at = case when p_status in ('delivered','read') then coalesce(delivered_at, p_at) else delivered_at end,
    error = case when p_status = 'failed' then left(coalesce(p_error, 'delivery failed'), 500) else error end
  where provider_message_id = p_provider_id and status <> 'blocked_no_opt_in';
end $$;

-- ---------- 3. Inbound WhatsApp ----------
-- Logs the message. STOP opts the patient out at once. Any other reply from a known patient becomes a task.
-- Returns 'duplicate', 'stop' or 'reply'.
create or replace function record_inbound_message(
  p_clinic uuid, p_phone text, p_body text, p_provider_id text default null
) returns text
language plpgsql as $$
declare v_patient uuid; v_name text; v_inserted uuid;
begin
  select id, full_name into v_patient, v_name from patients
   where clinic_id = p_clinic and deleted_at is null
     and right(regexp_replace(phone, '\D', '', 'g'), 10) = right(regexp_replace(p_phone, '\D', '', 'g'), 10)
   order by created_at desc limit 1;

  insert into inbound_messages (clinic_id, patient_id, from_phone, body, provider_message_id)
  values (p_clinic, v_patient, p_phone, left(coalesce(p_body, ''), 2000), p_provider_id)
  on conflict (clinic_id, provider_message_id) where provider_message_id is not null do nothing
  returning id into v_inserted;
  if v_inserted is null then return 'duplicate'; end if;

  if upper(trim(coalesce(p_body, ''))) in ('STOP','STOP ALL','UNSUBSCRIBE') then
    if v_patient is not null then
      insert into whatsapp_opt_events (clinic_id, patient_id, event, source)
      values (p_clinic, v_patient, 'opt_out', 'whatsapp_stop');
    end if;
    return 'stop';
  end if;

  if v_patient is not null then
    insert into tasks (clinic_id, assignee_id, patient_id, title, due_at, source)
    values (p_clinic, scan_task_owner(p_clinic), v_patient,
            'Reply to ' || v_name || ' on WhatsApp: "' || left(trim(p_body), 80) || '"', now(), 'system');
  end if;
  return 'reply';
end $$;

-- Server only.
do $$
declare f text;
begin
  foreach f in array array[
    'enqueue_scan_deadline_alerts(interval)', 'claim_outbound_batch(int)',
    'mark_outbound_sent(uuid,text)', 'mark_outbound_failed(uuid,text,boolean)',
    'record_delivery_status(text,text,timestamptz,text)', 'record_inbound_message(uuid,text,text,text)'
  ] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;
