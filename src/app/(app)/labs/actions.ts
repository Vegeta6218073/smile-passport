'use server';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requirePermission } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { dbMessage, go } from '@/lib/flash';
import { localToUtc } from '@/lib/dates';

const back = (fd: FormData) => {
  const p = String(fd.get('back') ?? '/labs');
  return /^\/(labs|patients\/[0-9a-f-]{36})$/.test(p) ? p : '/labs';
};

export async function createLabOrder(formData: FormData) {
  const member = await requirePermission('lab:write');
  const path = back(formData);
  const v = z.object({
    patient_id: z.string().uuid(),
    vendor: z.string().trim().min(2).max(120),
    item: z.string().trim().min(2).max(200),
    expected: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    treatment_step_id: z.string().uuid().optional().or(z.literal('').transform(() => undefined)),
    note: z.string().trim().max(500).optional(),
  }).safeParse(Object.fromEntries(formData));
  if (!v.success) go(path, 'error', 'Enter the lab, the item and the expected date.');
  const { error } = await createClient().from('lab_orders').insert({
    clinic_id: member.clinicId, patient_id: v.data.patient_id, vendor: v.data.vendor, item: v.data.item,
    expected_at: localToUtc(v.data.expected, '18:00', member.timezone).toISOString(),
    treatment_step_id: v.data.treatment_step_id ?? null, note: v.data.note || null, created_by: member.userId,
  });
  if (error) go(path, 'error', dbMessage(error));
  revalidatePath(path);
  go(path, 'ok', 'Lab order recorded.');
}

export async function setLabStatus(formData: FormData) {
  await requirePermission('lab:write');
  const path = back(formData);
  const id = z.string().uuid().safeParse(formData.get('id'));
  const status = z.enum(['delivered', 'cancelled']).safeParse(formData.get('status'));
  if (!id.success || !status.success) go(path, 'error', 'Invalid request.');
  const { error } = await createClient().rpc('set_lab_status', { p_order: id.data, p_status: status.data });
  if (error) go(path, 'error', dbMessage(error));
  revalidatePath(path);
  revalidatePath('/today');
  go(path, 'ok', status.data === 'delivered' ? 'Marked delivered.' : 'Cancelled.');
}
