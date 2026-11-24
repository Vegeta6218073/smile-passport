import Link from 'next/link';
import { requireMember } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { dateIn, timeIn, todayIn } from '@/lib/dates';

export const dynamic = 'force-dynamic';

const LABEL: Record<string, string> = {
  task: 'Task',
  overdue_step: 'Overdue treatment step',
  enquiry_unreplied: 'Enquiry waiting',
};

// Phase 1 Today queue: rule-based, no AI. Tasks due today or earlier, treatment steps past due,
// and enquiries past the clinic's reply target, followed by today's appointments.
export default async function TodayPage() {
  const member = await requireMember();
  const supabase = createClient();
  const today = todayIn(member.timezone);

  const [{ data: queue, error }, { data: appts }] = await Promise.all([
    supabase.from('today_queue').select('kind, ref_id, patient_id, title, due_at')
      .order('due_at', { ascending: true, nullsFirst: false }).limit(50),
    supabase.rpc('appointments_for_day', { p_day: today }),
  ]);

  return (
    <>
      <div className="card">
        <h2>Needs attention</h2>
        {error && <p className="error">Could not load the queue.</p>}
        {!error && (queue?.length ?? 0) === 0 && <p className="muted">Nothing overdue.</p>}
        <ul className="list">
          {queue?.map((row) => (
            <li key={`${row.kind}-${row.ref_id}`}>
              <strong>{LABEL[row.kind] ?? row.kind}</strong>{' '}
              {row.patient_id ? <Link href={`/patients/${row.patient_id}`}>{row.title}</Link> : row.title}{' '}
              {row.due_at && <span className="muted">due {dateIn(row.due_at, member.timezone)}</span>}
            </li>
          ))}
        </ul>
      </div>

      <div className="card">
        <h2>Today&apos;s appointments</h2>
        {(appts?.length ?? 0) === 0 && <p className="muted">Nothing booked today.</p>}
        <ul className="list">
          {appts?.map((a: any) => (
            <li key={a.id}>
              {timeIn(a.starts_at, member.timezone)}{' '}
              <Link href={`/patients/${a.patient_id}`}>{a.patient_name}</Link>{' '}
              <span className="muted">{a.visit_type.replace('_', '-')} · {a.status.replace('_', '-')}</span>
            </li>
          ))}
        </ul>
        <p><Link href={`/appointments?d=${today}`}>Open the schedule</Link></p>
      </div>
    </>
  );
}
