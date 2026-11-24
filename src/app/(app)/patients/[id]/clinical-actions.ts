'use server';
import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requireMember, requirePermission } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { captureError } from '@/lib/monitoring';
import { dbMessage, go } from '@/lib/flash';
import { parseRupees } from '@/lib/money';
import { DECLINE_REASONS, DOCUMENT_KINDS, MAX_DOCUMENT_BYTES, TOOTH_CONDITIONS, detectDocumentType, isFdiTooth } from '@/lib/clinical';
import { featureOn, getAiProvider, loadSwitches, logAiAction, reviewOutcome } from '@/lib/ai/gateway';
import { fillName } from '@/lib/ai/redact';
import { waLink } from '@/lib/scan';

const id = z.string().uuid();
const opt = (v: FormDataEntryValue | null) => (v === null || v === '' ? null : String(v));

function patientPath(formData: FormData) {
  const p = id.safeParse(formData.get('patient_id'));
  if (!p.success) go('/patients', 'error', 'Invalid request.');
  return { patientId: p.data, path: `/patients/${p.data}` };
}

// ---------- #28 Treatment plans ----------
export async function createPlan(formData: FormData) {
  const member = await requirePermission('treatment:write');
  const { patientId, path } = patientPath(formData);
  const title = z.string().trim().min(2).max(160).safeParse(formData.get('title'));
  const cost = parseRupees(formData.get('cost'));
  const months = z.coerce.number().int().min(1).max(120).optional().safeParse(opt(formData.get('duration_months')) ?? undefined);
  const inst = z.coerce.number().int().min(1).max(36).optional().safeParse(opt(formData.get('instalments')) ?? undefined);
  const tpl = z.string().uuid().optional().safeParse(opt(formData.get('template_id')) ?? undefined);
  if (!title.success || !months.success || !inst.success || !tpl.success) go(path, 'error', 'Check the plan details.');
  const { error } = await createClient().from('treatment_plans').insert({
    clinic_id: member.clinicId, patient_id: patientId, title: title.data, options: opt(formData.get('options'))?.slice(0, 2000) ?? null,
    cost_paise: cost, duration_months: months.data ?? null, instalments: inst.data ?? null, template_id: tpl.data ?? null,
    created_by: member.userId,
  });
  if (error) go(path, 'error', dbMessage(error));
  revalidatePath(path);
  go(path, 'ok', 'Plan saved as a draft. Offer it when it is ready.');
}

export async function planAction(formData: FormData) {
  await requirePermission('treatment:write');
  const { path } = patientPath(formData);
  const planId = id.safeParse(formData.get('plan_id'));
  const op = z.enum(['offer', 'accept', 'decline']).safeParse(formData.get('op'));
  if (!planId.success || !op.success) go(path, 'error', 'Invalid request.');
  const supabase = createClient();
  let error;
  if (op.data === 'offer') ({ error } = await supabase.rpc('offer_plan', { p_plan: planId.data }));
  else if (op.data === 'accept') {
    ({ error } = await supabase.rpc('accept_plan', {
      p_plan: planId.data, p_signed_by: String(formData.get('signed_by') ?? ''), p_consent_version: 'draft-v0',
    }));
  } else {
    const reason = z.enum(DECLINE_REASONS.map(([k]) => k) as [string, ...string[]]).safeParse(formData.get('reason'));
    if (!reason.success) go(path, 'error', 'Choose why the plan was declined.');
    ({ error } = await supabase.rpc('decline_plan', { p_plan: planId.data, p_reason: reason.data, p_note: opt(formData.get('note')) }));
  }
  if (error) go(path, 'error', dbMessage(error));
  revalidatePath(path);
  go(path, 'ok', op.data === 'offer' ? 'Plan offered.' : op.data === 'accept' ? 'Plan accepted and treatment started.' : 'Recorded as declined.');
}

// ---------- #29 Plan explainer (AI draft, clinician approves) ----------
export async function draftExplainer(formData: FormData) {
  const member = await requirePermission('treatment:write');
  const { path } = patientPath(formData);
  const planId = id.safeParse(formData.get('plan_id'));
  if (!planId.success) go(path, 'error', 'Invalid request.');
  const supabase = createClient();
  const [{ data: plan }, switches] = await Promise.all([
    supabase.from('treatment_plans').select('id, patient_id, title, options, cost_paise, duration_months, instalments, patients(full_name, preferred_language)')
      .eq('id', planId.data).maybeSingle(),
    loadSwitches(supabase, member.clinicId),
  ]);
  if (!plan) go(path, 'error', 'Plan not found.');
  if (!featureOn(switches, 'plan_explainer')) go(path, 'error', 'Plan explainers are switched off in Settings.');
  const patient = Array.isArray(plan.patients) ? plan.patients[0] : plan.patients;
  const provider = getAiProvider();
  const draft = await provider.explainPlan({
    language: patient?.preferred_language ?? 'en', title: plan.title, options: plan.options,
    durationMonths: plan.duration_months, costInr: plan.cost_paise ? Number(plan.cost_paise) / 100 : null, instalments: plan.instalments,
  });
  if (draft.handover) go(path, 'error', draft.sources[0] ?? 'No explainer for this language.');
  let actionId: string;
  try {
    actionId = await logAiAction(createAdminClient(), {
      clinicId: member.clinicId, feature: 'plan_explainer', patientId: plan.patient_id, subjectId: plan.id,
      inputRef: { treatment_plan_id: plan.id }, draft: fillName(draft.text, patient?.full_name), model: provider.name,
      grounded: draft.grounded, confidence: draft.confidence,
    });
  } catch (err) {
    captureError(err, { action: 'draftExplainer' });
    go(path, 'error', 'Could not create the explainer.');
  }
  go(`${path}?explainer=${actionId}#plans`, 'ok', 'Explainer drafted. A clinician must approve it before it is sent.');
}

export async function reviewExplainer(formData: FormData) {
  await requirePermission('clinical:write');
  const { path } = patientPath(formData);
  const actionId = id.safeParse(formData.get('action_id'));
  if (!actionId.success) go(path, 'error', 'Invalid request.');
  const discard = formData.get('decision') === 'discard';
  const finalText = String(formData.get('final_text') ?? '').trim().slice(0, 4000);
  const supabase = createClient();
  const { data: a } = await supabase.from('ai_actions').select('id, draft, patient_id').eq('id', actionId.data).maybeSingle();
  if (!a) go(path, 'error', 'Draft not found.');
  const { error } = await supabase.rpc('review_ai_draft', {
    p_action: a.id, p_final_text: finalText, p_outcome: reviewOutcome(a.draft ?? '', finalText, discard),
  });
  if (error) go(path, 'error', dbMessage(error));
  if (discard) go(path, 'ok', 'Explainer discarded.');
  const { data: p } = await supabase.from('patients').select('phone, whatsapp_opt_in').eq('id', a.patient_id).maybeSingle();
  go(p?.whatsapp_opt_in ? `${path}?send=${encodeURIComponent(waLink(p.phone, finalText))}` : path, 'ok',
    p?.whatsapp_opt_in ? 'Approved. Open WhatsApp to send it.' : 'Approved. The patient has not opted in to WhatsApp: share it in person or by email.');
}

// ---------- #31 Notes and tooth chart ----------
export async function addNote(formData: FormData) {
  const member = await requirePermission('clinical:write');
  const { patientId, path } = patientPath(formData);
  const body = z.string().trim().min(2).max(5000).safeParse(formData.get('body'));
  if (!body.success) go(path, 'error', 'Write the note first.');
  const { error } = await createClient().from('visit_notes').insert({
    clinic_id: member.clinicId, patient_id: patientId, author_id: member.userId, body: body.data,
    appointment_id: opt(formData.get('appointment_id')), treatment_step_id: opt(formData.get('treatment_step_id')),
  });
  if (error) go(path, 'error', dbMessage(error));
  revalidatePath(path);
  go(path, 'ok', 'Note saved.');
}

export async function addToothEntry(formData: FormData) {
  const member = await requirePermission('clinical:write');
  const { patientId, path } = patientPath(formData);
  const tooth = String(formData.get('tooth') ?? '').trim();
  const condition = z.enum(TOOTH_CONDITIONS).safeParse(formData.get('condition'));
  if (!isFdiTooth(tooth) || !condition.success) go(path, 'error', 'Use an FDI tooth number (e.g. 36) and choose a condition.');
  const { error } = await createClient().from('tooth_chart_entries').insert({
    clinic_id: member.clinicId, patient_id: patientId, tooth, condition: condition.data,
    note: opt(formData.get('note'))?.slice(0, 300) ?? null, recorded_by: member.userId,
    treatment_step_id: opt(formData.get('treatment_step_id')),
  });
  if (error) go(path, 'error', dbMessage(error));
  revalidatePath(path);
  go(path, 'ok', `Tooth ${tooth} recorded.`);
}

// ---------- #30 Documents (private storage) and photo consent ----------
export async function uploadDocument(formData: FormData) {
  const member = await requirePermission('scan:view');   // owner, doctor, coordinator
  const { patientId, path } = patientPath(formData);
  const kind = z.enum(DOCUMENT_KINDS.map(([k]) => k) as [string, ...string[]]).safeParse(formData.get('kind'));
  const file = formData.get('file');
  if (!kind.success || !(file instanceof File) || file.size === 0) go(path, 'error', 'Choose a file and what it is.');
  if (file.size > MAX_DOCUMENT_BYTES) go(path, 'error', 'Files must be under 10 MB.');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const type = detectDocumentType(bytes);
  if (!type) go(path, 'error', 'Only PDF, JPEG, PNG or WebP files.');
  const storagePath = `${member.clinicId}/patients/${patientId}/${randomUUID()}.${type.ext}`;
  const supabase = createClient();
  const { error: upErr } = await supabase.storage.from('clinic-files').upload(storagePath, bytes, { contentType: type.type });
  if (upErr) { captureError(upErr, { action: 'uploadDocument' }); go(path, 'error', 'Could not store the file.'); }
  const { error } = await supabase.from('documents').insert({
    clinic_id: member.clinicId, patient_id: patientId, kind: kind.data, storage_path: storagePath,
    title: opt(formData.get('title'))?.slice(0, 160) ?? file.name.slice(0, 160), content_type: type.type, bytes: bytes.length,
    uploaded_by: member.userId, appointment_id: opt(formData.get('appointment_id')),
  });
  if (error) {
    await supabase.storage.from('clinic-files').remove([storagePath]);
    go(path, 'error', dbMessage(error));
  }
  revalidatePath(path);
  go(path, 'ok', 'File added to the record.');
}

export async function recordPhotoConsent(formData: FormData) {
  const member = await requireMember();
  const { patientId, path } = patientPath(formData);
  const givenBy = z.string().trim().min(2).max(120).safeParse(formData.get('given_by'));
  if (!givenBy.success) go(path, 'error', 'Who gave consent?');
  const { error } = await createClient().from('consents').insert({
    clinic_id: member.clinicId, patient_id: patientId, kind: 'photo_use', text_version: 'draft-v0', given_by: givenBy.data,
  });
  if (error) go(path, 'error', dbMessage(error));
  revalidatePath(path);
  go(path, 'ok', 'Photo consent recorded. Photos the patient sends on WhatsApp will now be attached.');
}

// ---------- #38 Family links ----------
export async function linkFamily(formData: FormData) {
  const member = await requirePermission('patient:merge');
  const { patientId, path } = patientPath(formData);
  const other = id.safeParse(formData.get('related_patient_id'));
  if (!other.success || other.data === patientId) go(path, 'error', 'Choose another patient.');
  const [a, b] = [patientId, other.data].sort();
  const { error } = await createClient().from('patient_family_links').insert({
    clinic_id: member.clinicId, patient_id: a, related_patient_id: b,
    relation: String(formData.get('relation') ?? 'family').slice(0, 40) || 'family', created_by: member.userId,
  });
  if (error) go(path, 'error', dbMessage(error));
  revalidatePath(path);
  go(path, 'ok', 'Family link saved.');
}
