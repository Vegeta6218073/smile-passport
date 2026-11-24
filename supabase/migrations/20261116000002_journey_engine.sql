-- S-One journey engine (runs under the caller's RLS; security invoker by default)
-- Rule: next step's due date = ACTUAL completion of the latest finished step
--       + the next step's interval from the SOP. Late visits push later steps later.
-- Skipped steps are ignored when finding the base date.
-- CLINICAL DECISION TO CONFIRM with the doctor: should a skipped step's interval
-- still be added? Currently it is not.

create or replace function recompute_next_due(p_treatment uuid) returns void
language plpgsql as $$
declare
  v_base timestamptz;
  v_next record;
begin
  select coalesce(
           max(ts.completed_at) filter (where ts.status = 'done'),
           (select started_at from patient_treatments where id = p_treatment)
         )
    into v_base
    from treatment_steps ts
   where ts.patient_treatment_id = p_treatment;

  select ts.id, coalesce(ss.days_after_previous, 0) as days
    into v_next
    from treatment_steps ts
    left join sop_steps ss on ss.id = ts.sop_step_id
   where ts.patient_treatment_id = p_treatment and ts.status = 'pending'
   order by ts.position
   limit 1;

  if found then
    update treatment_steps
       set due_at = v_base + make_interval(days => v_next.days)
     where id = v_next.id;
  else
    update patient_treatments
       set status = 'completed', completed_at = v_base
     where id = p_treatment and status = 'active';
  end if;
end $$;

create or replace function start_treatment(
  p_patient uuid, p_template uuid, p_doctor uuid default null,
  p_started_at timestamptz default now()
) returns uuid
language plpgsql as $$
declare
  v_clinic uuid;
  v_id uuid;
begin
  select clinic_id into v_clinic from sop_templates where id = p_template;
  if v_clinic is null then raise exception 'template not found'; end if;

  insert into patient_treatments (clinic_id, patient_id, template_id, doctor_id, status, started_at)
  values (v_clinic, p_patient, p_template, p_doctor, 'active', p_started_at)
  returning id into v_id;

  insert into treatment_steps (clinic_id, patient_treatment_id, sop_step_id, position, name)
  select v_clinic, v_id, id, position, name
    from sop_steps where template_id = p_template order by position;

  perform recompute_next_due(v_id);
  return v_id;
end $$;

create or replace function advance_step(
  p_step uuid, p_status text, p_at timestamptz default now()
) returns void
language plpgsql as $$
declare
  v_treatment uuid;
  v_first_pending uuid;
begin
  if p_status not in ('done', 'skipped') then
    raise exception 'status must be done or skipped';
  end if;

  select patient_treatment_id into v_treatment from treatment_steps where id = p_step;
  if v_treatment is null then raise exception 'step not found'; end if;

  select id into v_first_pending
    from treatment_steps
   where patient_treatment_id = v_treatment and status = 'pending'
   order by position limit 1;

  if v_first_pending is distinct from p_step then
    raise exception 'only the next pending step can be completed or skipped';
  end if;

  update treatment_steps
     set status = p_status,
         completed_at = case when p_status = 'done' then p_at end
   where id = p_step;

  perform recompute_next_due(v_treatment);
end $$;

create or replace function complete_step(p_step uuid, p_at timestamptz default now())
returns void language sql as $$ select advance_step(p_step, 'done', p_at) $$;

create or replace function skip_step(p_step uuid)
returns void language sql as $$ select advance_step(p_step, 'skipped', now()) $$;

-- Powers the "overdue steps" tile and the delayed-cases report
create or replace view delayed_steps with (security_invoker = true) as
select ts.clinic_id, ts.id as step_id, ts.patient_treatment_id, pt.patient_id,
       ts.name, ts.due_at, now() - ts.due_at as overdue_by
  from treatment_steps ts
  join patient_treatments pt on pt.id = ts.patient_treatment_id
 where ts.status = 'pending' and ts.due_at < now() and pt.status = 'active';
