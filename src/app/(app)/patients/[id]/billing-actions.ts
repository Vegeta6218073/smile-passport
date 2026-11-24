'use server';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requirePermission } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { dbMessage, go } from '@/lib/flash';
import { parseRupees } from '@/lib/money';

const id = z.string().uuid();

function pathOf(formData: FormData) {
  const p = id.safeParse(formData.get('patient_id'));
  if (!p.success) go('/patients', 'error', 'Invalid request.');
  return `/patients/${p.data}`;
}

export async function createInstalmentPlan(formData: FormData) {
  await requirePermission('finance:write');
  const path = pathOf(formData);
  const treatment = id.safeParse(formData.get('treatment_id'));
  const total = parseRupees(formData.get('total'));
  const count = z.coerce.number().int().min(1).max(36).safeParse(formData.get('count'));
  const every = z.coerce.number().int().min(1).max(180).safeParse(formData.get('every_days'));
  const first = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).safeParse(formData.get('first_due'));
  if (!treatment.success || !total || !count.success || !every.success || !first.success) {
    go(path, 'error', 'Check the cost, number of instalments, first due date and interval.');
  }
  const { error } = await createClient().rpc('create_instalment_plan', {
    p_treatment: treatment.data, p_total_paise: total, p_count: count.data, p_first_due: first.data, p_every_days: every.data,
  });
  if (error) go(path, 'error', dbMessage(error));
  revalidatePath(path);
  go(path, 'ok', 'Instalment schedule saved.');
}

export async function recordPayment(formData: FormData) {
  await requirePermission('finance:write');
  const path = pathOf(formData);
  const payment = id.safeParse(formData.get('payment_id'));
  const amount = parseRupees(formData.get('amount'));
  const method = z.enum(['upi', 'cash', 'card', 'bank_transfer', 'cheque', 'other']).safeParse(formData.get('method'));
  if (!payment.success || !amount || !method.success) go(path, 'error', 'Enter the amount received and the method.');
  const { data, error } = await createClient().rpc('record_payment', {
    p_payment: payment.data, p_amount_paise: amount, p_method: method.data,
  });
  if (error) go(path, 'error', dbMessage(error));
  revalidatePath(path);
  revalidatePath('/today');
  go(`${path}?receipt=${data}`, 'ok', 'Payment recorded and a receipt issued.');
}

export async function issueInvoice(formData: FormData) {
  await requirePermission('finance:write');
  const path = pathOf(formData);
  const treatment = id.safeParse(formData.get('treatment_id'));
  if (!treatment.success) go(path, 'error', 'Invalid request.');
  const { error } = await createClient().rpc('issue_treatment_invoice', {
    p_treatment: treatment.data, p_description: String(formData.get('description') ?? '') || null,
  });
  if (error) go(path, 'error', dbMessage(error));
  revalidatePath(path);
  go(path, 'ok', 'Invoice issued.');
}

export async function logEmergency(formData: FormData) {
  await requirePermission('appointment:write');
  const path = pathOf(formData);
  const patient = id.parse(formData.get('patient_id'));
  const { error } = await createClient().rpc('log_emergency_visit', {
    p_patient: patient, p_reason: String(formData.get('reason') ?? ''),
  });
  if (error) go(path, 'error', dbMessage(error));
  revalidatePath(path);
  go(path, 'ok', 'Emergency visit logged. The treatment schedule is unchanged unless a clinician links it.');
}

export async function linkVisit(formData: FormData) {
  await requirePermission('clinical:write');
  const path = pathOf(formData);
  const appt = id.safeParse(formData.get('appointment_id'));
  const step = id.safeParse(formData.get('step_id'));
  if (!appt.success || !step.success) go(path, 'error', 'Choose the step this visit counts as.');
  const { error } = await createClient().rpc('link_visit_to_step', { p_appointment: appt.data, p_step: step.data });
  if (error) go(path, 'error', dbMessage(error));
  revalidatePath(path);
  go(path, 'ok', 'Visit linked. The step is complete and the next one is rescheduled from it.');
}

export async function shiftSchedule(formData: FormData) {
  await requirePermission('clinical:write');
  const path = pathOf(formData);
  const treatment = id.safeParse(formData.get('treatment_id'));
  const days = z.coerce.number().int().min(-90).max(90).safeParse(formData.get('days'));
  if (!treatment.success || !days.success || days.data === 0) go(path, 'error', 'Shift by 1 to 90 days.');
  const { error } = await createClient().rpc('shift_next_step', { p_treatment: treatment.data, p_days: days.data });
  if (error) go(path, 'error', dbMessage(error));
  revalidatePath(path);
  go(path, 'ok', 'Next step moved.');
}
