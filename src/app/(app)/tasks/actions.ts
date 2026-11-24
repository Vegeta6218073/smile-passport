'use server';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requireMember } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { dbMessage, go } from '@/lib/flash';
import { can } from '@/lib/roles';
import { taskSchema } from '@/lib/validation';

export async function createTask(formData: FormData) {
  const member = await requireMember();
  const parsed = taskSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) go('/tasks', 'error', 'A task needs a title.');
  const v = parsed.data;

  // Only owner and coordinator can hand work to someone else; everyone else assigns to themselves.
  const assignee = can(member.role, 'task:assign_any') ? v.assignee_id ?? member.userId : member.userId;

  const { error } = await createClient().from('tasks').insert({
    clinic_id: member.clinicId,
    assignee_id: assignee,
    title: v.title,
    due_at: v.due_at ? new Date(v.due_at).toISOString() : null,
    created_by: member.userId,
  });
  if (error) go('/tasks', 'error', dbMessage(error));
  revalidatePath('/tasks');
  go('/tasks', 'ok', 'Task added.');
}

export async function completeTask(formData: FormData) {
  await requireMember();
  const id = z.string().uuid().safeParse(formData.get('id'));
  const outcome = String(formData.get('outcome') ?? '');
  if (!id.success) go('/tasks', 'error', 'Invalid request.');

  const supabase = createClient();
  const { error } = await supabase.rpc('complete_task', { p_task: id.data, p_outcome: outcome });
  if (error) go('/tasks', 'error', dbMessage(error));
  await supabase.rpc('track_usage', { p_event: 'queue_item_done', p_path: null });
  revalidatePath('/tasks');
  revalidatePath('/today');
  go('/tasks', 'ok', 'Task closed.');
}
