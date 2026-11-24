'use server';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requirePermission } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { captureError } from '@/lib/monitoring';
import { dbMessage, go } from '@/lib/flash';
import { clinicSettingsSchema, inviteSchema, templateSchema } from '@/lib/settings';
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
