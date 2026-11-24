'use server';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requireMember } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { dbMessage, go } from '@/lib/flash';

export async function closeRecall(formData: FormData) {
  await requireMember();
  const id = z.string().uuid().safeParse(formData.get('id'));
  if (!id.success) go('/recalls', 'error', 'Invalid request.');
  const { error } = await createClient().rpc('close_recall', {
    p_recall: id.data, p_reason: String(formData.get('reason') ?? ''),
  });
  if (error) go('/recalls', 'error', dbMessage(error));
  revalidatePath('/recalls');
  go('/recalls', 'ok', 'Recall closed with a reason.');
}
