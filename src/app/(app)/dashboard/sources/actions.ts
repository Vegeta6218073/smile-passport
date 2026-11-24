'use server';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requirePermission } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { dbMessage, go } from '@/lib/flash';
import { parseRupees } from '@/lib/money';
import { LEAD_SOURCES } from '@/lib/constants';

export async function saveSpend(formData: FormData) {
  const member = await requirePermission('finance:write');
  const month = z.string().regex(/^\d{4}-\d{2}$/).safeParse(formData.get('month'));
  const source = z.enum(LEAD_SOURCES.map(([k]) => k) as [string, ...string[]]).safeParse(formData.get('source'));
  const raw = String(formData.get('amount') ?? '').trim();
  const amount = raw === '0' ? 0 : parseRupees(raw);
  if (!month.success || !source.success || amount === null) go('/dashboard/sources', 'error', 'Choose the month and source and enter the amount.');
  const { error } = await createClient().from('ad_spend').upsert(
    { clinic_id: member.clinicId, month: `${month.data}-01`, source: source.data, amount_paise: amount },
    { onConflict: 'clinic_id,month,source' });
  if (error) go('/dashboard/sources', 'error', dbMessage(error));
  revalidatePath('/dashboard/sources');
  go('/dashboard/sources', 'ok', 'Spend saved.');
}
