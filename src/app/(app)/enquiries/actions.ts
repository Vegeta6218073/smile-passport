'use server';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requirePermission } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { captureError } from '@/lib/monitoring';
import { dbMessage, go } from '@/lib/flash';
import { enquirySchema } from '@/lib/validation';
import { featureOn, getAiProvider, loadSwitches, logAiAction, reviewOutcome } from '@/lib/ai/gateway';
import { fillName, redact } from '@/lib/ai/redact';
import { formatSlot, openSlots, type OpeningHours } from '@/lib/ai/slots';
import { waLink } from '@/lib/scan';

export async function createEnquiry(formData: FormData) {
  const member = await requirePermission('enquiry:write');
  const parsed = enquirySchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) go('/enquiries', 'error', parsed.error.issues[0].message);
  const v = parsed.data;

  const { error } = await createClient().from('enquiries').insert({
    clinic_id: member.clinicId,
    name: v.name,
    phone: v.phone,
    lead_source: v.lead_source,
    channel: v.channel,
    referrer_note: v.referrer_note ?? null,
    message: v.message ?? null,
    preferred_language: v.preferred_language,
    owner_id: member.userId,
  });
  if (error) go('/enquiries', 'error', dbMessage(error));
  revalidatePath('/enquiries');
  go('/enquiries', 'ok', 'Enquiry captured.');
}

const STAGES = ['first_reply', 'consult_booked', 'consult_attended', 'plan_offered', 'case_started', 'case_completed', 'lost'] as const;

export async function advanceEnquiry(formData: FormData) {
  await requirePermission('enquiry:write');
  const id = z.string().uuid().safeParse(formData.get('id'));
  const stage = z.enum(STAGES).safeParse(formData.get('stage'));
  const reason = String(formData.get('reason') ?? '').trim();
  if (!id.success || !stage.success) go('/enquiries', 'error', 'Invalid request.');

  const { error } = await createClient().rpc('advance_enquiry', {
    p_enquiry: id.data,
    p_stage: stage.data,
    p_reason: reason || null,
  });
  if (error) go('/enquiries', 'error', dbMessage(error));
  revalidatePath('/enquiries');
  go('/enquiries', 'ok', 'Updated.');
}

// #18: draft a reply from the clinic's approved answers, price ranges and open slots.
// The provider never sees the name or phone. Nothing is sent: staff review the draft first.
export async function draftReply(formData: FormData) {
  const member = await requirePermission('enquiry:write');
  const id = z.string().uuid().safeParse(formData.get('id'));
  if (!id.success) go('/enquiries', 'error', 'Invalid request.');
  const supabase = createClient();

  const [{ data: e }, { data: faqs }, { data: prices }, { data: clinic }] = await Promise.all([
    supabase.from('enquiries').select('id, name, phone, message, preferred_language, patient_id').eq('id', id.data).maybeSingle(),
    supabase.from('clinic_faqs').select('question, answer, keywords').eq('active', true),
    supabase.from('clinic_price_ranges').select('treatment, min_inr, max_inr, note').eq('active', true),
    supabase.from('clinics').select('name, timezone, opening_hours, slot_minutes, ai_enabled, ai_features').eq('id', member.clinicId).single(),
  ]);
  if (!e || !clinic) go('/enquiries', 'error', 'Enquiry not found.');
  if (!featureOn(clinic, 'enquiry_reply')) go('/enquiries', 'error', 'Reply drafts are switched off in Settings.');
  if (!e.message?.trim()) go('/enquiries', 'error', 'Add what the person asked before drafting a reply.');

  const from = new Date();
  const { data: busy } = await supabase.from('appointments').select('starts_at, ends_at')
    .in('status', ['booked', 'arrived']).gte('starts_at', from.toISOString())
    .lte('starts_at', new Date(from.getTime() + 7 * 86400_000).toISOString());
  const slots = openSlots({
    hours: clinic.opening_hours as OpeningHours, slotMinutes: clinic.slot_minutes, busy: busy ?? [], timeZone: clinic.timezone,
  }).map((d) => formatSlot(d, clinic.timezone));

  const provider = getAiProvider();
  const draft = await provider.draftEnquiryReply({
    question: redact(e.message, [e.name]),
    language: e.preferred_language,
    clinicName: clinic.name,
    faqs: faqs ?? [],
    prices: prices ?? [],
    slots,
  });
  if (draft.handover) go('/enquiries', 'error', draft.sources[0] ?? 'No draft for this enquiry. Reply yourself.');

  let actionId: string;
  try {
    actionId = await logAiAction(createAdminClient(), {
      clinicId: member.clinicId, feature: 'enquiry_reply', patientId: e.patient_id, subjectId: e.id,
      inputRef: { enquiry_id: e.id, sources: draft.sources }, draft: fillName(draft.text, e.name),
      model: provider.name, grounded: draft.grounded, confidence: draft.confidence,
    });
  } catch (err) {
    captureError(err, { action: 'draftReply' });
    go('/enquiries', 'error', 'Could not create the draft.');
  }
  go(`/enquiries?draft=${actionId}#draft`, 'ok', 'Draft ready. Check and edit it before sending.');
}

// Staff approve (as is or edited) or discard. Approving marks the enquiry replied and opens WhatsApp.
export async function reviewDraft(formData: FormData) {
  await requirePermission('enquiry:write');
  const id = z.string().uuid().safeParse(formData.get('action_id'));
  if (!id.success) go('/enquiries', 'error', 'Invalid request.');
  const discard = formData.get('decision') === 'discard';
  const finalText = String(formData.get('final_text') ?? '').trim().slice(0, 4000);
  const supabase = createClient();

  const { data: a } = await supabase.from('ai_actions').select('id, draft, subject_id').eq('id', id.data).maybeSingle();
  if (!a) go('/enquiries', 'error', 'Draft not found.');
  const outcome = reviewOutcome(a.draft ?? '', finalText, discard);
  const { error } = await supabase.rpc('review_ai_draft', { p_action: a.id, p_final_text: finalText, p_outcome: outcome });
  if (error) go('/enquiries', 'error', dbMessage(error));
  revalidatePath('/enquiries');
  if (discard) go('/enquiries', 'ok', 'Draft discarded.');

  const { data: e } = await supabase.from('enquiries').select('id, phone').eq('id', a.subject_id).maybeSingle();
  if (e) await supabase.rpc('advance_enquiry', { p_enquiry: e.id, p_stage: 'first_reply', p_reason: null });
  go(`/enquiries?send=${encodeURIComponent(e ? waLink(e.phone, finalText) : '')}`, 'ok',
    'Approved and marked as replied. Open WhatsApp to send it.');
}
