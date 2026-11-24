'use server';
import { revalidatePath } from 'next/cache';
import { requireMember } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { captureError } from '@/lib/monitoring';
import { dbMessage, go } from '@/lib/flash';
import { patientSchema } from '@/lib/validation';

// TODO(counsel): consent wording and version are placeholders until legal review is done.
const CONSENT_TEXT_VERSION = 'draft-v0';

export async function createPatient(formData: FormData) {
  const member = await requireMember();
  const parsed = patientSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) go('/patients', 'error', parsed.error.issues[0].message);
  const v = parsed.data;

  const supabase = createClient();

  if (!v.confirm_duplicate) {
    const { data: dupes } = await supabase.rpc('find_duplicate_patients', { p_phone: v.phone });
    if (dupes && dupes.length > 0) {
      go('/patients', 'error',
        `A patient with this phone already exists (${dupes[0].full_name}). Tick "add anyway" to continue.`);
    }
  }

  const { data: patient, error } = await supabase
    .from('patients')
    .insert({
      clinic_id: member.clinicId,
      full_name: v.full_name,
      phone: v.phone,
      email: v.email ?? null,
      dob: v.dob ?? null,
      sex: v.sex ?? null,
      preferred_language: v.preferred_language,
      guardian_name: v.guardian_name ?? null,
      guardian_phone: v.guardian_phone ?? null,
      lead_source: v.lead_source ?? null,
    })
    .select('id')
    .single();
  if (error || !patient) {
    captureError(error, { action: 'createPatient' });
    go('/patients', 'error', error ? dbMessage(error) : 'Could not save the patient.');
  }

  const givenBy = v.guardian_name ?? v.full_name;
  const { error: consentError } = await supabase.from('consents').insert({
    clinic_id: member.clinicId,
    patient_id: patient.id,
    kind: 'data_processing',
    text_version: CONSENT_TEXT_VERSION,
    given_by: givenBy,
  });
  if (consentError) captureError(consentError, { action: 'createPatient.consent' });

  if (v.whatsapp_opt_in) {
    // The event trigger sets patients.whatsapp_opt_in. Never set the flag directly.
    const { error: optError } = await supabase.from('whatsapp_opt_events').insert({
      clinic_id: member.clinicId,
      patient_id: patient.id,
      event: 'opt_in',
      source: 'registration',
      captured_by: member.userId,
    });
    if (optError) captureError(optError, { action: 'createPatient.optIn' });
  }

  revalidatePath('/patients');
  go(`/patients/${patient.id}`, 'ok', 'Patient added.');
}
