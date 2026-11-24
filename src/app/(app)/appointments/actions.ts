'use server';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requirePermission } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { dbMessage, go } from '@/lib/flash';
import { bookingSchema } from '@/lib/validation';

export async function bookAppointment(formData: FormData) {
  await requirePermission('appointment:write');
  const parsed = bookingSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) go('/appointments', 'error', 'Check the patient, date, time and duration.');
  const v = parsed.data;
  const path = `/appointments?d=${v.day}`;

  const { error } = await createClient().rpc('book_appointment', {
    p_patient: v.patient_id,
    p_doctor: v.doctor_id ?? null,
    p_chair: v.chair ?? null,
    p_day: v.day,
    p_time: v.time,
    p_minutes: v.minutes,
    p_visit_type: v.visit_type,
  });
  if (error) go(path, 'error', dbMessage(error));
  revalidatePath('/appointments');
  go(path, 'ok', 'Appointment booked.');
}

export async function changeStatus(formData: FormData) {
  await requirePermission('appointment:write');
  const id = z.string().uuid().safeParse(formData.get('id'));
  const status = z.enum(['arrived', 'completed', 'no_show', 'cancelled']).safeParse(formData.get('status'));
  const day = String(formData.get('day') ?? '');
  if (!id.success || !status.success) go('/appointments', 'error', 'Invalid request.');
  const path = `/appointments?d=${day}`;

  const { error } = await createClient().rpc('set_appointment_status', { p_id: id.data, p_status: status.data });
  if (error) go(path, 'error', dbMessage(error));
  revalidatePath('/appointments');
  go(path, 'ok', 'Updated.');
}

export async function reschedule(formData: FormData) {
  await requirePermission('appointment:write');
  const id = z.string().uuid().safeParse(formData.get('id'));
  const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).safeParse(formData.get('day'));
  const time = z.string().regex(/^\d{2}:\d{2}$/).safeParse(formData.get('time'));
  const from = String(formData.get('from') ?? '');
  if (!id.success || !day.success || !time.success) go('/appointments', 'error', 'Check the new date and time.');

  const { error } = await createClient().rpc('reschedule_appointment', {
    p_id: id.data, p_day: day.data, p_time: time.data,
  });
  if (error) go(`/appointments?d=${from}`, 'error', dbMessage(error));
  revalidatePath('/appointments');
  go(`/appointments?d=${day.data}`, 'ok', 'Rescheduled.');
}
