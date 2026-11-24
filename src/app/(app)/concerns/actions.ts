'use server';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requireMember, requirePermission } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { dbMessage, go } from '@/lib/flash';

const id = z.string().uuid();

function back(formData: FormData) {
  const p = String(formData.get('back') ?? '/concerns');
  return /^\/(concerns|patients\/[0-9a-f-]{36})$/.test(p) ? p : '/concerns';
}

// Any staff member can raise one (front desk takes calls); it goes to the patient's clinician.
export async function raiseConcern(formData: FormData) {
  await requireMember();
  const patientId = id.safeParse(formData.get('patient_id'));
  const severity = z.enum(['urgent', 'mild', 'unclear']).safeParse(formData.get('severity'));
  if (!patientId.success || !severity.success) go(back(formData), 'error', 'Invalid request.');
  const { error } = await createClient().rpc('raise_concern', {
    p_patient: patientId.data, p_severity: severity.data, p_summary: String(formData.get('summary') ?? ''),
  });
  if (error) go(back(formData), 'error', dbMessage(error));
  revalidatePath('/concerns');
  revalidatePath('/today');
  go(back(formData), 'ok', 'Concern raised and assigned to the clinician.');
}

export async function acknowledgeConcern(formData: FormData) {
  await requirePermission('concern:view');
  const cid = id.safeParse(formData.get('id'));
  if (!cid.success) go(back(formData), 'error', 'Invalid request.');
  const { error } = await createClient().rpc('acknowledge_concern', { p_concern: cid.data });
  if (error) go(back(formData), 'error', dbMessage(error));
  revalidatePath('/concerns');
  go(back(formData), 'ok', 'Acknowledged.');
}

export async function resolveConcern(formData: FormData) {
  await requirePermission('concern:view');
  const cid = id.safeParse(formData.get('id'));
  const label = z.enum(['urgent', 'mild', 'fine', '']).safeParse(formData.get('clinician_label') ?? '');
  if (!cid.success || !label.success) go(back(formData), 'error', 'Invalid request.');
  const { error } = await createClient().rpc('resolve_concern', {
    p_concern: cid.data, p_outcome: String(formData.get('outcome') ?? ''), p_clinician_label: label.data || null,
  });
  if (error) go(back(formData), 'error', dbMessage(error));
  revalidatePath('/concerns');
  revalidatePath('/today');
  go(back(formData), 'ok', 'Resolved. The outcome is on the patient record.');
}

export async function sendCheckin(formData: FormData) {
  await requirePermission('concern:view');
  const patientId = id.safeParse(formData.get('patient_id'));
  if (!patientId.success) go('/patients', 'error', 'Invalid request.');
  const path = `/patients/${patientId.data}`;
  const { data, error } = await createClient().rpc('send_checkin', { p_patient: patientId.data });
  if (error) go(path, 'error', dbMessage(error));
  const { data: k } = await createClient().from('checkins').select('status').eq('id', data).maybeSingle();
  revalidatePath(path);
  go(path, 'ok', k?.status === 'sent'
    ? 'Check-in queued on WhatsApp.'
    : 'No WhatsApp opt-in or approved template, so the check-in is on the Today list as a phone call.');
}

export async function recordCheckin(formData: FormData) {
  await requirePermission('concern:view');
  const cid = id.safeParse(formData.get('id'));
  const status = z.enum(['ok', 'concern', 'cancelled']).safeParse(formData.get('status'));
  if (!cid.success || !status.success) go(back(formData), 'error', 'Invalid request.');
  const { error } = await createClient().rpc('record_checkin_outcome', {
    p_checkin: cid.data, p_status: status.data, p_note: String(formData.get('note') ?? '') || null,
  });
  if (error) go(back(formData), 'error', dbMessage(error));
  revalidatePath(back(formData));
  revalidatePath('/today');
  go(back(formData), 'ok', 'Check-in recorded.');
}
