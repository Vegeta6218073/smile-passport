-- Smile Passport MVP plan (Stages 1 to 9, Week 1 to Month 3):
--   1 "Meet the orthodontist" on the landing page (clinic settings)
--   2 Week 4 feedback questions, recorded by staff during the follow-up
--   3 funnel: review speed (the 24h promise), feedback, and a per-source breakdown (Month 2 content)

-- ---------- 1. Orthodontist profile shown on the public landing page ----------
alter table clinics add column orthodontist_name text;
alter table clinics add column orthodontist_bio text;

-- ---------- 2. Feedback (Week 4: "Was uploading easy? Did the report make sense? ...") ----------
alter table smile_scans add column feedback_upload_easy boolean;
alter table smile_scans add column feedback_report_clear boolean;
alter table smile_scans add column feedback_would_recommend boolean;
alter table smile_scans add column feedback_confusion text;
alter table smile_scans add column feedback_at timestamptz;

-- Staff ask the questions when they follow up and record the answers. Unanswered questions stay null.
-- Runs as the caller, so the scans RLS rules decide who may record it (front desk cannot).
create or replace function record_scan_feedback(
  p_scan uuid, p_upload_easy boolean, p_report_clear boolean, p_would_recommend boolean, p_confusion text
) returns void
language plpgsql as $$
begin
  if p_upload_easy is null and p_report_clear is null and p_would_recommend is null
     and coalesce(trim(p_confusion), '') = '' then
    raise exception 'record at least one answer';
  end if;
  update smile_scans set
    feedback_upload_easy = p_upload_easy,
    feedback_report_clear = p_report_clear,
    feedback_would_recommend = p_would_recommend,
    feedback_confusion = nullif(left(trim(p_confusion), 1000), ''),
    feedback_at = now()
  where id = p_scan and report_sent_at is not null;
  if not found then raise exception 'send the report before recording feedback'; end if;
end $$;

-- ---------- 3. Funnel ----------
-- Same cohort view as before, plus how fast reports reach people and what they said.
drop function if exists smile_funnel(date, date);
create function smile_funnel(p_from date, p_to date)
returns table (visits bigint, scans bigint, reviews_delivered bigint,
               consults_booked bigint, treatments_started bigint,
               reviews_on_time bigint, avg_hours_to_report numeric,
               feedback_count bigint, would_recommend bigint)
language sql stable as $$
  select
    (select coalesce(sum(f.visits), 0) from funnel_daily f where f.day between p_from and p_to),
    count(*),
    count(*) filter (where s.report_sent_at is not null),
    count(*) filter (where s.consult_booked_at is not null),
    count(*) filter (where s.treatment_started_at is not null),
    count(*) filter (where s.report_sent_at is not null and s.report_sent_at <= s.review_due_at),
    round((avg(extract(epoch from (s.report_sent_at - s.submitted_at)) / 3600)
           filter (where s.report_sent_at is not null))::numeric, 1),
    count(*) filter (where s.feedback_at is not null),
    count(*) filter (where s.feedback_would_recommend)
  from smile_scans s join clinics c on c.id = s.clinic_id
  where (s.submitted_at at time zone c.timezone)::date between p_from and p_to
$$;

-- Which content or channel brings people who go on to book (utm_source from the landing link).
create or replace function smile_funnel_sources(p_from date, p_to date)
returns table (source text, scans bigint, reviews_delivered bigint,
               consults_booked bigint, treatments_started bigint)
language sql stable as $$
  select
    coalesce(nullif(lower(trim(s.source)), ''), '(direct)'),
    count(*),
    count(*) filter (where s.report_sent_at is not null),
    count(*) filter (where s.consult_booked_at is not null),
    count(*) filter (where s.treatment_started_at is not null)
  from smile_scans s join clinics c on c.id = s.clinic_id
  where (s.submitted_at at time zone c.timezone)::date between p_from and p_to
  group by 1
  order by 2 desc, 1
$$;
