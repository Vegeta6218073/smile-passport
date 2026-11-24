'use server';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requireMember } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { go } from '@/lib/flash';

export async function markAllRead() {
  await requireMember();
  await createClient().rpc('mark_notifications_read', { p_ids: null });
  revalidatePath('/', 'layout');
  go('/notifications', 'ok', 'All marked as read.');
}

const subscriptionSchema = z.object({
  endpoint: z.string().url().startsWith('https://').max(1000),
  keys: z.object({ p256dh: z.string().min(10).max(200), auth: z.string().min(8).max(100) }),
});

// Called from the browser after the user allows notifications on this device.
export async function savePushSubscription(json: string): Promise<{ ok: boolean; message: string }> {
  const member = await requireMember();
  let parsed;
  try { parsed = subscriptionSchema.safeParse(JSON.parse(json)); } catch { return { ok: false, message: 'Invalid subscription.' }; }
  if (!parsed.success) return { ok: false, message: 'Invalid subscription.' };
  const { error } = await createClient().from('push_subscriptions').upsert({
    clinic_id: member.clinicId, user_id: member.userId, endpoint: parsed.data.endpoint,
    p256dh: parsed.data.keys.p256dh, auth: parsed.data.keys.auth,
  }, { onConflict: 'endpoint' });
  return error ? { ok: false, message: 'Could not save this device.' } : { ok: true, message: 'This device will get notifications.' };
}
