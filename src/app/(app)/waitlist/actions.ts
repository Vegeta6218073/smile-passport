'use server';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requireMember } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { dbMessage, go } from '@/lib/flash';

export async function addToWaitlist(formData: FormData) {
  const member = await requireMember();
  const v = z.object({
    patient_id: z.string().uuid(),
    earliest: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    latest: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    doctor_id: z.string().uuid().optional().or(z.literal('').transform(() => undefined)),
    note: z.string().trim().max(300).optional(),
  }).refine((x) => x.latest >= x.earliest, 'The last date must be on or after the first')
    .safeParse(Object.fromEntries(formData));
  if (!v.success) go('/waitlist', 'error', v.error.issues[0]?.message ?? 'Check the dates.');
  const { error } = await createClient().from('waitlist_entries').insert({
    clinic_id: member.clinicId, patient_id: v.data.patient_id, earliest: v.data.earliest, latest: v.data.latest,
    doctor_id: v.data.doctor_id ?? null, note: v.data.note || null, created_by: member.userId,
  });
  if (error) go('/waitlist', 'error', dbMessage(error));
  revalidatePath('/waitlist');
  go('/waitlist', 'ok', 'Added. A cancelled slot in that window is offered to them automatically.');
}

export async function removeFromWaitlist(formData: FormData) {
  await requireMember();
  const id = z.string().uuid().safeParse(formData.get('id'));
  if (!id.success) go('/waitlist', 'error', 'Invalid request.');
  const { error } = await createClient().from('waitlist_entries').update({ status: 'removed' }).eq('id', id.data);
  if (error) go('/waitlist', 'error', dbMessage(error));
  revalidatePath('/waitlist');
  go('/waitlist', 'ok', 'Removed from the waitlist.');
}

export async function bookOffer(formData: FormData) {
  await requireMember();
  const id = z.string().uuid().safeParse(formData.get('id'));
  if (!id.success) go('/waitlist', 'error', 'Invalid request.');
  const { error } = await createClient().rpc('book_slot_offer', { p_offer: id.data });
  if (error) go('/waitlist', 'error', dbMessage(error));
  revalidatePath('/waitlist');
  revalidatePath('/appointments');
  go('/waitlist', 'ok', 'Booked into the freed slot.');
}
