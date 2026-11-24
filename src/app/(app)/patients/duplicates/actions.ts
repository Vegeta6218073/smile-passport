'use server';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requirePermission } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { dbMessage, go } from '@/lib/flash';

const pair = z.object({ a: z.string().uuid(), b: z.string().uuid() });

export async function resolveDuplicate(formData: FormData) {
  const member = await requirePermission('patient:merge');
  const p = pair.safeParse({ a: formData.get('a'), b: formData.get('b') });
  const op = z.enum(['keep_a', 'keep_b', 'family', 'different']).safeParse(formData.get('op'));
  if (!p.success || !op.success) go('/patients/duplicates', 'error', 'Invalid request.');
  const [a, b] = [p.data.a, p.data.b].sort();
  const supabase = createClient();
  let error;
  if (op.data === 'keep_a' || op.data === 'keep_b') {
    const keep = op.data === 'keep_a' ? p.data.a : p.data.b;
    const merge = op.data === 'keep_a' ? p.data.b : p.data.a;
    ({ error } = await supabase.rpc('merge_patients', { p_keep: keep, p_merge: merge }));
  } else if (op.data === 'family') {
    ({ error } = await supabase.from('patient_family_links').insert({
      clinic_id: member.clinicId, patient_id: a, related_patient_id: b,
      relation: String(formData.get('relation') ?? '').slice(0, 40) || 'family', created_by: member.userId,
    }));
  } else {
    ({ error } = await supabase.from('patient_not_duplicates').insert({
      clinic_id: member.clinicId, patient_a: a, patient_b: b, created_by: member.userId,
    }));
  }
  if (error) go('/patients/duplicates', 'error', dbMessage(error));
  revalidatePath('/patients/duplicates');
  revalidatePath('/patients');
  go('/patients/duplicates', 'ok', op.data.startsWith('keep') ? 'Merged. Everything now sits on one record.' : 'Saved.');
}
