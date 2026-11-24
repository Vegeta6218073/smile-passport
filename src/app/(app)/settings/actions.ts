'use server';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requirePermission } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { captureError } from '@/lib/monitoring';
import { dbMessage, go } from '@/lib/flash';
import {
  billingSettingsSchema, clinicSettingsSchema, faqSchema, inviteSchema, priceSchema, scheduleSettingsSchema, templateSchema,
} from '@/lib/settings';
import { AI_FEATURES } from '@/lib/ai/types';
import { ALL_ROLES } from '@/lib/roles';

const first = (e: z.ZodError) => e.issues[0]?.message ?? 'Check the form.';

export async function saveClinicSettings(formData: FormData) {
  const member = await requirePermission('settings:manage');
  const parsed = clinicSettingsSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) go('/settings', 'error', first(parsed.error));

  // Goes through the signed-in client, so the database's owner-only rule applies too.
  const { error } = await createClient().from('clinics').update(parsed.data).eq('id', member.clinicId);
  if (error) go('/settings', 'error', dbMessage(error));
  revalidatePath('/settings');
  go('/settings', 'ok', 'Clinic settings saved.');
}

// Owner-only clinic updates share one path: parse, update through the signed-in client, report back.
async function updateClinic(formData: FormData, schema: z.ZodTypeAny, ok: string, input?: Record<string, unknown>) {
  const member = await requirePermission('settings:manage');
  const parsed = schema.safeParse(input ?? Object.fromEntries(formData));
  if (!parsed.success) go('/settings', 'error', first(parsed.error));
  const { error } = await createClient().from('clinics').update(parsed.data).eq('id', member.clinicId);
  if (error) go('/settings', 'error', dbMessage(error));
  revalidatePath('/settings');
  go('/settings', 'ok', ok);
}

export async function saveBillingSettings(formData: FormData) {
  await updateClinic(formData, billingSettingsSchema, 'Invoice details saved.');
}

export async function saveScheduleSettings(formData: FormData) {
  await updateClinic(formData, scheduleSettingsSchema, 'Hours and follow-up timing saved.',
    { ...Object.fromEntries(formData), days: formData.getAll('days') });
}

export async function saveAiSettings(formData: FormData) {
  const features = Object.fromEntries(AI_FEATURES.map(([k]) => [k, formData.get(`feature_${k}`) === 'on']));
  await updateClinic(formData, z.object({ ai_enabled: z.boolean(), ai_features: z.record(z.boolean()) }),
    'AI settings saved.', { ai_enabled: formData.get('ai_enabled') === 'on', ai_features: features });
}

export async function addFaq(formData: FormData) {
  const member = await requirePermission('settings:manage');
  const parsed = faqSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) go('/settings', 'error', first(parsed.error));
  const { error } = await createClient().from('clinic_faqs').insert({ clinic_id: member.clinicId, ...parsed.data });
  if (error) go('/settings', 'error', dbMessage(error));
  revalidatePath('/settings');
  go('/settings', 'ok', 'Answer added. Reply drafts can now use it.');
}

export async function addPrice(formData: FormData) {
  const member = await requirePermission('settings:manage');
  const parsed = priceSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) go('/settings', 'error', first(parsed.error));
  const { error } = await createClient().from('clinic_price_ranges').upsert(
    { clinic_id: member.clinicId, ...parsed.data }, { onConflict: 'clinic_id,treatment' });
  if (error) go('/settings', 'error', dbMessage(error));
  revalidatePath('/settings');
  go('/settings', 'ok', 'Price range saved.');
}

export async function removeKnowledge(formData: FormData) {
  await requirePermission('settings:manage');
  const id = z.string().uuid().safeParse(formData.get('id'));
  const table = z.enum(['clinic_faqs', 'clinic_price_ranges']).safeParse(formData.get('table'));
  if (!id.success || !table.success) go('/settings', 'error', 'Invalid request.');
  const { error } = await createClient().from(table.data).delete().eq('id', id.data);
  if (error) go('/settings', 'error', dbMessage(error));
  revalidatePath('/settings');
  go('/settings', 'ok', 'Removed.');
}

export async function saveTemplate(formData: FormData) {
  const member = await requirePermission('template:write');
  const parsed = templateSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) go('/settings', 'error', first(parsed.error));

  const { error } = await createClient().from('message_templates').upsert(
    { clinic_id: member.clinicId, ...parsed.data },
    { onConflict: 'clinic_id,key,language' },
  );
  if (error) go('/settings', 'error', dbMessage(error));
  revalidatePath('/settings');
  go('/settings', 'ok', 'Message template saved.');
}

// ---------- Team (owner only). Uses the service role because members cannot edit membership themselves. ----------

type Admin = ReturnType<typeof createAdminClient>;

async function findUserIdByEmail(admin: Admin, email: string): Promise<string | null> {
  for (let page = 1; page <= 5; page++) {
    const { data } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    const hit = data?.users.find((u) => u.email?.toLowerCase() === email);
    if (hit) return hit.id;
    if (!data || data.users.length < 200) break;
  }
  return null;
}

export async function inviteStaff(formData: FormData) {
  const member = await requirePermission('settings:manage');
  const parsed = inviteSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) go('/settings', 'error', first(parsed.error));
  const v = parsed.data;
  const admin = createAdminClient();

  const { data: invited, error: inviteError } = await admin.auth.admin.inviteUserByEmail(v.email);
  let userId = invited?.user?.id ?? null;
  if (!userId) {
    userId = await findUserIdByEmail(admin, v.email); // already has an account
    if (!userId) {
      captureError(inviteError, { action: 'inviteStaff' });
      go('/settings', 'error', 'Could not send the invite. Check the email address and the mail settings.');
    }
  }

  // One clinic per person for now. The message is deliberately generic.
  const { data: elsewhere } = await admin.from('clinic_members').select('clinic_id')
    .eq('user_id', userId).eq('active', true).neq('clinic_id', member.clinicId).limit(1);
  if (elsewhere && elsewhere.length > 0) go('/settings', 'error', 'That email cannot be added to this clinic.');

  const { error } = await admin.from('clinic_members').upsert(
    { clinic_id: member.clinicId, user_id: userId, role: v.role, display_name: v.display_name, active: true },
    { onConflict: 'clinic_id,user_id' },
  );
  if (error) {
    captureError(error, { action: 'inviteStaff.member' });
    go('/settings', 'error', 'The invite was sent but the team member could not be saved.');
  }
  revalidatePath('/settings');
  go('/settings', 'ok', `Invite sent to ${v.email}.`);
}

async function otherActiveOwners(admin: Admin, clinicId: string, exceptUserId: string) {
  const { count } = await admin.from('clinic_members').select('user_id', { count: 'exact', head: true })
    .eq('clinic_id', clinicId).eq('role', 'owner').eq('active', true).neq('user_id', exceptUserId);
  return count ?? 0;
}

export async function setStaffActive(formData: FormData) {
  const member = await requirePermission('settings:manage');
  const userId = z.string().uuid().safeParse(formData.get('user_id'));
  const active = formData.get('active') === 'true';
  if (!userId.success) go('/settings', 'error', 'Invalid request.');
  if (userId.data === member.userId) go('/settings', 'error', 'You cannot change your own access.');

  const admin = createAdminClient();
  const { data: target } = await admin.from('clinic_members').select('role')
    .eq('clinic_id', member.clinicId).eq('user_id', userId.data).maybeSingle();
  if (!target) go('/settings', 'error', 'That person is not in this clinic.');
  if (!active && target.role === 'owner' && (await otherActiveOwners(admin, member.clinicId, userId.data)) === 0) {
    go('/settings', 'error', 'The clinic needs at least one active owner.');
  }

  const { error } = await admin.from('clinic_members').update({ active })
    .eq('clinic_id', member.clinicId).eq('user_id', userId.data);
  if (error) go('/settings', 'error', dbMessage(error));
  revalidatePath('/settings');
  go('/settings', 'ok', active ? 'Access restored.' : 'Access removed. They are signed out at their next request.');
}

export async function changeStaffRole(formData: FormData) {
  const member = await requirePermission('settings:manage');
  const userId = z.string().uuid().safeParse(formData.get('user_id'));
  const role = z.enum(ALL_ROLES as [string, ...string[]]).safeParse(formData.get('role'));
  if (!userId.success || !role.success) go('/settings', 'error', 'Invalid request.');
  if (userId.data === member.userId) go('/settings', 'error', 'You cannot change your own role.');

  const admin = createAdminClient();
  const { data: target } = await admin.from('clinic_members').select('role')
    .eq('clinic_id', member.clinicId).eq('user_id', userId.data).maybeSingle();
  if (!target) go('/settings', 'error', 'That person is not in this clinic.');
  if (target.role === 'owner' && role.data !== 'owner' && (await otherActiveOwners(admin, member.clinicId, userId.data)) === 0) {
    go('/settings', 'error', 'The clinic needs at least one owner.');
  }

  const { error } = await admin.from('clinic_members').update({ role: role.data })
    .eq('clinic_id', member.clinicId).eq('user_id', userId.data);
  if (error) go('/settings', 'error', dbMessage(error));
  revalidatePath('/settings');
  go('/settings', 'ok', 'Role updated.');
}
