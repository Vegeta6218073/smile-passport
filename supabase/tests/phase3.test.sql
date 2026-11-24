-- pgTAP tests for Phase 3 (roadmap #28 to #41). Run with `supabase test db`
begin;
select * from no_plan();

-- ---------- Fixture ----------
insert into auth.users (id, email) values
  ('c1000000-0000-0000-0000-000000000001', 'owner@p3.local'),
  ('c1000000-0000-0000-0000-000000000002', 'doc@p3.local'),
  ('c1000000-0000-0000-0000-000000000003', 'desk@p3.local'),
  ('c1000000-0000-0000-0000-000000000004', 'coord@p3.local');
insert into clinics (id, name, google_review_url) values
  ('c2000000-0000-0000-0000-000000000001', 'Clinic P3', 'https://g.page/r/review');
insert into clinic_members (clinic_id, user_id, role, display_name) values
  ('c2000000-0000-0000-0000-000000000001', 'c1000000-0000-0000-0000-000000000001', 'owner', 'Owner'),
  ('c2000000-0000-0000-0000-000000000001', 'c1000000-0000-0000-0000-000000000002', 'doctor', 'Dr Doc'),
  ('c2000000-0000-0000-0000-000000000001', 'c1000000-0000-0000-0000-000000000003', 'front_desk', 'Desk'),
  ('c2000000-0000-0000-0000-000000000001', 'c1000000-0000-0000-0000-000000000004', 'coordinator', 'Coord');
insert into patients (id, clinic_id, full_name, phone, whatsapp_opt_in, dob) values
  ('c3000000-0000-0000-0000-000000000001', 'c2000000-0000-0000-0000-000000000001', 'Meera Das', '9500000001', true, '1995-05-05'),
  ('c3000000-0000-0000-0000-000000000002', 'c2000000-0000-0000-0000-000000000001', 'Meera Das', '9500000099', false, '1995-05-05'),
  ('c3000000-0000-0000-0000-000000000003', 'c2000000-0000-0000-0000-000000000001', 'Kiran Das', '9500000001', false, null);
insert into message_templates (clinic_id, key, language, provider_template_name, body, approved)
select 'c2000000-0000-0000-0000-000000000001', k, 'en', k, 'Hi {{1}}', true
  from unnest(array['feedback_request','google_review','slot_offer']) k;
insert into enquiries (clinic_id, patient_id, name, phone, lead_source)
values ('c2000000-0000-0000-0000-000000000001', 'c3000000-0000-0000-0000-000000000001', 'Meera Das', '9500000001', 'instagram');

-- SOPs: a 2-step treatment whose retention phase starts by itself
insert into sop_templates (id, clinic_id, name, status, phase, retention_sop_name) values
  ('c4000000-0000-0000-0000-000000000001', 'c2000000-0000-0000-0000-000000000001', 'Aligners', 'draft', 'treatment', 'Retention'),
  ('c4000000-0000-0000-0000-000000000002', 'c2000000-0000-0000-0000-000000000001', 'Retention', 'draft', 'retention', null);
insert into sop_steps (clinic_id, template_id, position, name, days_after_previous) values
  ('c2000000-0000-0000-0000-000000000001', 'c4000000-0000-0000-0000-000000000001', 1, 'Start', 0),
  ('c2000000-0000-0000-0000-000000000001', 'c4000000-0000-0000-0000-000000000001', 2, 'Debond', 30),
  ('c2000000-0000-0000-0000-000000000001', 'c4000000-0000-0000-0000-000000000002', 1, 'Retainer check', 30),
  ('c2000000-0000-0000-0000-000000000001', 'c4000000-0000-0000-0000-000000000002', 2, '6 month follow-up', 150);
update sop_templates set status = 'published', reviewed_by = 'Dr Doc';
select throws_ok($$update sop_templates set retention_sop_name = 'Other' where id = 'c4000000-0000-0000-0000-000000000001'$$,
  'P0001', null, 'a published SOP keeps its retention link');

-- ===== #28 plans, as the doctor =====
select set_config('request.jwt.claims', '{"sub":"c1000000-0000-0000-0000-000000000002","role":"authenticated"}', true);
set local role authenticated;
insert into treatment_plans (id, clinic_id, patient_id, template_id, title, cost_paise, duration_months, instalments)
values ('c5000000-0000-0000-0000-000000000001', 'c2000000-0000-0000-0000-000000000001', 'c3000000-0000-0000-0000-000000000001',
        'c4000000-0000-0000-0000-000000000001', 'Clear aligners', 12000000, 12, 6),
       ('c5000000-0000-0000-0000-000000000002', 'c2000000-0000-0000-0000-000000000001', 'c3000000-0000-0000-0000-000000000001',
        null, 'Braces', 6000000, 18, 6);
select throws_ok($$select accept_plan('c5000000-0000-0000-0000-000000000001', 'Meera', 'v1')$$, 'P0001', null,
  'a draft plan cannot be accepted');
select lives_ok($$select offer_plan('c5000000-0000-0000-0000-000000000001')$$, 'plan offered');
select is((select status from enquiries where phone = '9500000001'), 'plan_offered', 'offering stamps the funnel');
select lives_ok($$select offer_plan('c5000000-0000-0000-0000-000000000002')$$, 'second plan offered');
select lives_ok($$select decline_plan('c5000000-0000-0000-0000-000000000002', 'price')$$, 'declined with a reason');
select lives_ok($$select accept_plan('c5000000-0000-0000-0000-000000000001', 'Meera Das', 'v1')$$, 'plan accepted');
select is((select status from enquiries where phone = '9500000001'), 'case_started', 'accepting stamps case started');
select is((select count(*) from consents where kind = 'treatment'), 1::bigint, 'treatment consent recorded');
select is((select total_cost_paise from patient_treatments where id =
  (select patient_treatment_id from treatment_plans where id = 'c5000000-0000-0000-0000-000000000001')), 12000000::bigint,
  'the treatment starts with the plan cost');
select is((select n from plan_outcomes where decline_reason = 'price'), 1::bigint, 'quoted-not-started reasons are counted');

-- ===== #31 notes and tooth chart =====
select throws_ok($$insert into tooth_chart_entries (clinic_id, patient_id, tooth, condition)
  values ('c2000000-0000-0000-0000-000000000001', 'c3000000-0000-0000-0000-000000000001', '19', 'decayed')$$,
  '23514', null, 'tooth numbers use FDI notation');
select lives_ok($$insert into tooth_chart_entries (clinic_id, patient_id, tooth, condition)
  values ('c2000000-0000-0000-0000-000000000001', 'c3000000-0000-0000-0000-000000000001', '36', 'bracket')$$, 'FDI 36 is accepted');

-- ===== #32 labs =====
insert into lab_orders (id, clinic_id, patient_id, treatment_step_id, vendor, item, expected_at)
select 'c6000000-0000-0000-0000-000000000001', clinic_id, 'c3000000-0000-0000-0000-000000000001', id, 'Aligner Lab', 'Trays 1-5', now() - interval '3 days'
  from treatment_steps where name = 'Debond';
update treatment_steps set due_at = now() - interval '5 days' where name = 'Debond';
select is((select cause from delayed_cases where patient_id = 'c3000000-0000-0000-0000-000000000001'),
  'Waiting on lab: Aligner Lab (Trays 1-5)', 'a late lab order is shown as the cause of the delay');
select is((select count(*) from today_queue where kind = 'lab_overdue'), 1::bigint, 'late lab work is on the Today queue');
select lives_ok($$select set_lab_status('c6000000-0000-0000-0000-000000000001', 'delivered')$$, 'lab delivered');

-- ===== #33 retention starts after debond =====
select lives_ok($$select complete_step(id) from treatment_steps where name = 'Start'$$, 'first step done');
select lives_ok($$select complete_step(id) from treatment_steps where name = 'Debond'$$, 'debond done');
select is((select count(*) from patient_treatments pt join sop_templates t on t.id = pt.template_id
  where t.phase = 'retention' and pt.status = 'active'), 1::bigint, 'the retention SOP started by itself');

-- ===== #39 notifications =====
reset role;
insert into tasks (clinic_id, assignee_id, title, created_by)
values ('c2000000-0000-0000-0000-000000000001', 'c1000000-0000-0000-0000-000000000004', 'Call the lab', 'c1000000-0000-0000-0000-000000000001');
select raise_concern('c3000000-0000-0000-0000-000000000001', 'urgent', 'Bleeding gums');
select set_config('request.jwt.claims', '{"sub":"c1000000-0000-0000-0000-000000000004","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*) from notifications), 1::bigint, 'the coordinator is notified of the task given to them');
select lives_ok($$select mark_notifications_read()$$, 'marked read');
select is((select count(*) from notifications where read_at is null), 0::bigint, 'nothing unread');
reset role;
select set_config('request.jwt.claims', '{"sub":"c1000000-0000-0000-0000-000000000002","role":"authenticated"}', true);
set local role authenticated;
select is((select urgent from notifications where kind = 'concern'), true, 'the doctor gets an urgent concern notification');

-- ===== #35 feedback (server) =====
reset role;
insert into appointments (id, clinic_id, patient_id, doctor_id, starts_at, ends_at, visit_type, status)
values ('c7000000-0000-0000-0000-000000000001', 'c2000000-0000-0000-0000-000000000001', 'c3000000-0000-0000-0000-000000000001',
        'c1000000-0000-0000-0000-000000000002', now() - interval '3 hours', now() - interval '150 minutes', 'new', 'completed');
select ok(enqueue_feedback_requests() >= 1, 'feedback requests go out after a first consultation and debond');
select is((select status from feedback_requests where trigger = 'first_consult'), 'sent', 'first consultation request sent');
select is((select result from record_inbound_message('c2000000-0000-0000-0000-000000000001', '9500000001', '5 - lovely team', 'w.f1')),
  'feedback', 'a rating reply is recognised');
select is((select rating from feedback_requests where status = 'answered' order by answered_at desc limit 1), 5, 'rating stored');
select is((select count(*) from outbound_messages where kind = 'google_review'), 1::bigint, 'a 5 prompts a Google review');
select is((select result from record_inbound_message('c2000000-0000-0000-0000-000000000001', '9500000001', '1 bad', 'w.f2')),
  'feedback', 'a second rating answers the other request');
select is((select count(*) from tasks where title like 'Low feedback (1/5)%'
  and assignee_id = 'c1000000-0000-0000-0000-000000000001'), 1::bigint, 'a low score alerts the owner privately');
select is((select answered from feedback_by_doctor where doctor_id = 'c1000000-0000-0000-0000-000000000002'), 2::bigint,
  'scores are grouped by doctor');

-- ===== #34 photos =====
select is((select result from record_inbound_message('c2000000-0000-0000-0000-000000000001', '9500000001', '', 'w.p1', 'media1', 'image/jpeg')),
  'photo', 'an image is recognised');
select is(handle_whatsapp_photo((select id from inbound_messages where provider_message_id = 'w.p1')), 'no_consent',
  'without photo consent nothing is stored');
insert into consents (clinic_id, patient_id, kind, text_version, given_by)
values ('c2000000-0000-0000-0000-000000000001', 'c3000000-0000-0000-0000-000000000001', 'photo_use', 'v1', 'Meera Das');
select is(handle_whatsapp_photo((select id from inbound_messages where provider_message_id = 'w.p1'),
  'c2000000-0000-0000-0000-000000000001/patients/x/wa.jpg', 'image/jpeg', 1000), 'stored', 'with consent it is attached');
select is((select count(*) from documents where source = 'whatsapp'), 1::bigint, 'the photo is a document');

-- ===== #40 waitlist =====
insert into waitlist_entries (id, clinic_id, patient_id, earliest, latest)
values ('c8000000-0000-0000-0000-000000000001', 'c2000000-0000-0000-0000-000000000001', 'c3000000-0000-0000-0000-000000000001',
        current_date, current_date + 14);
insert into appointments (id, clinic_id, patient_id, starts_at, ends_at, visit_type)
values ('c7000000-0000-0000-0000-000000000002', 'c2000000-0000-0000-0000-000000000001', 'c3000000-0000-0000-0000-000000000003',
        now() + interval '3 days', now() + interval '3 days 30 minutes', 'follow_up');
update appointments set status = 'cancelled' where id = 'c7000000-0000-0000-0000-000000000002';
select is((select count(*) from slot_offers where status = 'offered'), 1::bigint, 'the cancelled slot is offered to the waitlist');
select is((select count(*) from outbound_messages where kind = 'slot_offer'), 1::bigint, 'on WhatsApp');
select is((select result from record_inbound_message('c2000000-0000-0000-0000-000000000001', '9500000001', 'Yes please', 'w.s1')),
  'slot_reply', 'YES is recognised');
select lives_ok($$select book_slot_offer((select id from slot_offers limit 1))$$, 'staff book it');
select is((select status from waitlist_entries), 'booked', 'the waitlist entry is done');

-- ===== #37 sources =====
select set_config('request.jwt.claims', '{"sub":"c1000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
set local role authenticated;
insert into ad_spend (clinic_id, month, source, amount_paise)
values ('c2000000-0000-0000-0000-000000000001', date_trunc('month', current_date)::date, 'instagram', 500000);
select results_eq($$select leads, cases_started, spend_paise from source_report(current_date - 30, current_date) where source = 'instagram'$$,
  $$values (1::bigint, 1::bigint, 500000::bigint)$$, 'source report shows leads, cases and spend');
select lives_ok($$select * from source_completion(6)$$, 'source completion by month');

-- ===== #38 duplicates and merge =====
select is((select count(*) from duplicate_candidates), 2::bigint, 'same phone and same name+dob are both found');
insert into patient_family_links (clinic_id, patient_id, related_patient_id, relation)
select 'c2000000-0000-0000-0000-000000000001', least(a, b), greatest(a, b), 'sibling'
  from (values ('c3000000-0000-0000-0000-000000000001'::uuid, 'c3000000-0000-0000-0000-000000000003'::uuid)) v(a, b);
select is((select count(*) from duplicate_candidates), 1::bigint, 'family members sharing a phone are not duplicates');
reset role;
select set_config('request.jwt.claims', '{"sub":"c1000000-0000-0000-0000-000000000003","role":"authenticated"}', true);
set local role authenticated;
select throws_ok($$select merge_patients('c3000000-0000-0000-0000-000000000001', 'c3000000-0000-0000-0000-000000000002')$$,
  '42501', null, 'front desk cannot merge');
select is((select count(*) from treatment_plans), 0::bigint, 'front desk cannot read plans');
reset role;
select set_config('request.jwt.claims', '{"sub":"c1000000-0000-0000-0000-000000000004","role":"authenticated"}', true);
set local role authenticated;
select lives_ok($$select merge_patients('c3000000-0000-0000-0000-000000000001', 'c3000000-0000-0000-0000-000000000002')$$,
  'coordinator merges');
select ok((select deleted_at is not null from patients where id = 'c3000000-0000-0000-0000-000000000002'), 'the duplicate is soft-deleted');
select is((select count(*) from patient_merges), 1::bigint, 'the merge is recorded with a snapshot');
select is((select count(*) from duplicate_candidates), 0::bigint, 'no duplicates left');

reset role;
select * from finish();
rollback;
