import { requireMember } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { can } from '@/lib/roles';
import { dateIn } from '@/lib/dates';
import { completeTask, createTask } from './actions';

export const dynamic = 'force-dynamic';

export default async function TasksPage({
  searchParams,
}: {
  searchParams: { error?: string; ok?: string };
}) {
  const member = await requireMember();
  const supabase = createClient();
  const assignAny = can(member.role, 'task:assign_any');

  const [{ data: tasks, error }, { data: members }] = await Promise.all([
    supabase.from('tasks').select('id, title, due_at, assignee_id, patient_id')
      .eq('status', 'open').order('due_at', { ascending: true, nullsFirst: false }).limit(100),
    assignAny
      ? supabase.from('clinic_members').select('user_id, display_name, role').eq('active', true)
      : Promise.resolve({ data: [] }),
  ]);
  const nameOf = (id: string | null) =>
    id === member.userId ? 'you' : members?.find((m) => m.user_id === id)?.display_name ?? 'a colleague';

  return (
    <>
      {searchParams.error && <p className="error">{searchParams.error}</p>}
      {searchParams.ok && <p>{searchParams.ok}</p>}

      <div className="card">
        <h2>{assignAny ? 'Open tasks' : 'My tasks'}</h2>
        {error && <p className="error">Could not load tasks.</p>}
        {tasks?.length === 0 && <p className="muted">Nothing open.</p>}
        <ul className="list">
          {tasks?.map((t) => (
            <li key={t.id}>
              {t.title}{' '}
              <span className="muted">
                {assignAny ? `for ${nameOf(t.assignee_id)} · ` : ''}
                {t.due_at ? `due ${dateIn(t.due_at, member.timezone)}` : 'no due date'}
              </span>
              <form action={completeTask}>
                <input type="hidden" name="id" value={t.id} />
                <input name="outcome" placeholder="Outcome (required)" aria-label="Outcome" required />
                <button type="submit">Done</button>
              </form>
            </li>
          ))}
        </ul>
      </div>

      <div className="card">
        <h2>Add a task</h2>
        <form action={createTask}>
          <label htmlFor="title">Task</label>
          <input id="title" name="title" required />
          <label htmlFor="due_at">Due</label>
          <input id="due_at" name="due_at" type="datetime-local" />
          {assignAny && (
            <>
              <label htmlFor="assignee_id">Assign to</label>
              <select id="assignee_id" name="assignee_id" defaultValue={member.userId}>
                {members?.map((m) => (
                  <option key={m.user_id} value={m.user_id}>{m.display_name ?? m.role}</option>
                ))}
              </select>
            </>
          )}
          <button type="submit">Add</button>
        </form>
      </div>
    </>
  );
}
