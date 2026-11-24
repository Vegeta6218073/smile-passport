'use server';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requireMember, requirePermission } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { dbMessage, go } from '@/lib/flash';
import { medicalWritable } from '@/lib/roles';
import { patientEditSchema } from '@/lib/validation';

const id = z.string().uuid();

export async function setOptIn(formData: FormData) {
  const member = await requireMember();
  const patientId = id.safeParse(formData.get('patient_id'));
  const event = z.enum(['opt_in', 'opt_out']).safeParse(formData.get('event'));
  if (!patientId.success || !event.success) go('/patients', 'error', 'Invalid request.');
  const path = `/patients/${patientId.data}`;

  const { error } = await createClient().from('whatsapp_opt_events').insert({
    clinic_id: member.clinicId,
    patient_id: patientId.data,
    event: event.data,
    source: 'staff',
    captured_by: member.userId,
  });
  if (error) go(path, 'error', dbMessage(error));
  revalidatePath(path);
  go(path, 'ok', event.data === 'opt_in' ? 'WhatsApp opt-in recorded.' : 'Opt-out recorded. No more messages will go out.');
}

export async function saveMedical(formData: FormData) {
  const member = await requireMember();
  if (!medicalWritable(member.role)) go('/patients', 'error', 'Your role is not allowed to do that.');
  const patientId = id.safeParse(formData.get('patient_id'));
  if (!patientId.success) go('/patients', 'error', 'Invalid request.');
  const path = `/patients/${patientId.data}`;

  const allergies = String(formData.get('allergies') ?? '')
    .split(',').map((a) => a.trim()).filter(Boolean).slice(0, 50);
  const notes = String(formData.get('history') ?? '').trim().slice(0, 5000);

  const { error } = await createClient().from('patient_medical').upsert({
    patient_id: patientId.data,
    clinic_id: member.clinicId,
    allergies,
    medical_history: { notes },
  });
  if (error) go(path, 'error', dbMessage(error));
  revalidatePath(path);
  go(path, 'ok', 'Medical details saved.');
}

export async function startTreatment(formData: FormData) {
  const member = await requirePermission('treatment:write');
  const patientId = id.safeParse(formData.get('patient_id'));
  const templateId = id.safeParse(formData.get('template_id'));
  if (!patientId.success || !templateId.success) go('/patients', 'error', 'Invalid request.');
  const path = `/patients/${patientId.data}`;

  const { error } = await createClient().rpc('start_treatment', {
    p_patient: patientId.data,
    p_template: templateId.data,
    p_doctor: member.role === 'doctor' ? member.userId : null,
  });
  if (error) go(path, 'error', dbMessage(error));
  revalidatePath(path);
  go(path, 'ok', 'Treatment started.');
}

export async function advanceStep(formData: FormData) {
  await requirePermission('treatment:write');
  const patientId = id.safeParse(formData.get('patient_id'));
  const stepId = id.safeParse(formData.get('step_id'));
  const status = z.enum(['done', 'skipped']).safeParse(formData.get('status'));
  if (!patientId.success || !stepId.success || !status.success) go('/patients', 'error', 'Invalid request.');
  const path = `/patients/${patientId.data}`;

  const { error } = await createClient().rpc('advance_step', {
    p_step: stepId.data,
    p_status: status.data,
  });
  if (error) go(path, 'error', dbMessage(error));
  revalidatePath(path);
  go(path, 'ok', status.data === 'done' ? 'Step completed.' : 'Step skipped.');
}

export async function updatePatient(formData: FormData) {
  await requirePermission('patient:write');
  const patientId = id.safeParse(formData.get('patient_id'));
  if (!patientId.success) go('/patients', 'error', 'Invalid request.');
  const path = `/patients/${patientId.data}`;

  const parsed = patientEditSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) go(path, 'error', parsed.error.issues[0].message);
  const v = parsed.data;

  const supabase = createClient();
  const { data: dupes } = await supabase.rpc('find_duplicate_patients', { p_phone: v.phone });
  if (dupes?.some((d: { id: string }) => d.id !== patientId.data) && formData.get('confirm_duplicate') !== 'on') {
    go(path, 'error', 'Another patient already has this phone number. Tick "save anyway" if that is correct.');
  }

  const { error } = await supabase.from('patients').update({
    full_name: v.full_name,
    phone: v.phone,
    email: v.email ?? null,
    dob: v.dob ?? null,
    sex: v.sex ?? null,
    preferred_language: v.preferred_language,
    guardian_name: v.guardian_name ?? null,
    guardian_phone: v.guardian_phone ?? null,
  }).eq('id', patientId.data);
  if (error) go(path, 'error', dbMessage(error));
  revalidatePath(path);
  revalidatePath('/patients');
  go(path, 'ok', 'Details updated.');
}
