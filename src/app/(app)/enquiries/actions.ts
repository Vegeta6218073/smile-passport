'use server';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requirePermission } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { dbMessage, go } from '@/lib/flash';
import { enquirySchema } from '@/lib/validation';

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
