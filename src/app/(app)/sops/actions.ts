'use server';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requirePermission } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { dbMessage, go } from '@/lib/flash';

const id = z.string().uuid();

export async function createSop(formData: FormData) {
  const member = await requirePermission('sop:write');
  const name = z.string().trim().min(2).max(80).safeParse(formData.get('name'));
  if (!name.success) go('/sops', 'error', 'Give the SOP a name.');

  const phase = z.enum(['treatment', 'retention']).catch('treatment').parse(formData.get('phase'));
  const { error } = await createClient().from('sop_templates').insert({
    clinic_id: member.clinicId, name: name.data, version: 1, phase,
  });
  if (error) go('/sops', 'error', dbMessage(error));
  revalidatePath('/sops');
  go('/sops', 'ok', 'Draft created. Add steps, then publish with clinician sign-off.');
}

export async function addStep(formData: FormData) {
  const member = await requirePermission('sop:write');
  const templateId = id.safeParse(formData.get('template_id'));
  const name = z.string().trim().min(2).max(120).safeParse(formData.get('name'));
  const days = z.coerce.number().int().min(0).max(730).safeParse(formData.get('days'));
  if (!templateId.success || !name.success || !days.success) go('/sops', 'error', 'Check the step name and days.');

  const supabase = createClient();
  const { data: last } = await supabase.from('sop_steps').select('position')
    .eq('template_id', templateId.data).order('position', { ascending: false }).limit(1).maybeSingle();

  const { error } = await supabase.from('sop_steps').insert({
    clinic_id: member.clinicId,
    template_id: templateId.data,
    position: (last?.position ?? 0) + 1,
    name: name.data,
    days_after_previous: days.data,
  });
  if (error) go('/sops', 'error', dbMessage(error));
  revalidatePath('/sops');
  go('/sops', 'ok', 'Step added.');
}

export async function publishSop(formData: FormData) {
  await requirePermission('sop:write');
  const templateId = id.safeParse(formData.get('template_id'));
  const reviewer = String(formData.get('reviewed_by') ?? '');
  if (!templateId.success) go('/sops', 'error', 'Invalid request.');

  const { error } = await createClient().rpc('publish_sop', {
    p_template: templateId.data, p_reviewed_by: reviewer,
  });
  if (error) go('/sops', 'error', dbMessage(error));
  revalidatePath('/sops');
  go('/sops', 'ok', 'Published. Running treatments keep the version they started on.');
}

export async function newVersion(formData: FormData) {
  await requirePermission('sop:write');
  const templateId = id.safeParse(formData.get('template_id'));
  if (!templateId.success) go('/sops', 'error', 'Invalid request.');

  const { error } = await createClient().rpc('new_sop_version', { p_template: templateId.data });
  if (error) go('/sops', 'error', dbMessage(error));
  revalidatePath('/sops');
  go('/sops', 'ok', 'New draft version created.');
}

// Roadmap #33: which retention SOP starts by itself when this treatment completes (debond).
export async function setRetentionLink(formData: FormData) {
  await requirePermission('sop:write');
  const templateId = id.safeParse(formData.get('template_id'));
  const name = z.string().trim().max(80).safeParse(formData.get('retention_sop_name') ?? '');
  if (!templateId.success || !name.success) go('/sops', 'error', 'Invalid request.');
  const { error } = await createClient().from('sop_templates')
    .update({ retention_sop_name: name.data || null }).eq('id', templateId.data).eq('status', 'draft');
  if (error) go('/sops', 'error', dbMessage(error));
  revalidatePath('/sops');
  go('/sops', 'ok', name.data ? `"${name.data}" will start after this treatment completes.` : 'Retention link removed.');
}
