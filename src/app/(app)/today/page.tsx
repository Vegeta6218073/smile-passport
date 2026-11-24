import Link from 'next/link';
import { requireMember } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { timeIn, todayIn } from '@/lib/dates';
import { rankQueue, type QueueRow } from '@/lib/queue';

export const dynamic = 'force-dynamic';

const LABEL: Record<string, string> = {
  task: 'Task',
  overdue_step: 'Overdue treatment step',
  enquiry_unreplied: 'Enquiry waiting',
  scan_review: 'Smile scan',
  concern: 'Concern',
  checkin_call: 'Check-in',
  payment_overdue: 'Payment',
  lab_overdue: 'Lab',
};

// Where each kind of item is handled.
function linkFor(row: QueueRow): string | null {
  switch (row.kind) {
    case 'concern': return '/concerns';
    case 'scan_review': return `/scans/${row.ref_id}`;
    case 'enquiry_unreplied': return '/enquiries';
    case 'task': return row.patient_id ? `/patients/${row.patient_id}` : '/tasks';
    case 'lab_overdue': return '/labs';
    default: return row.patient_id ? `/patients/${row.patient_id}` : null;
  }
}

// Ranked by readable rules (roadmap #25): revenue at risk, days overdue and patient history.
// Each item shows why it is where it is. "Mine" shows only items assigned to you or to nobody.
export default async function TodayPage({ searchParams }: { searchParams: { mine?: string } }) {
  const member = await requireMember();
  const supabase = createClient();
  const today = todayIn(member.timezone);
  const mine = searchParams.mine === '1';

  const [{ data: queue, error }, { data: appts }] = await Promise.all([
    supabase.from('today_queue')
      .select('kind, ref_id, patient_id, title, due_at, assignee_id, severity, amount_paise, patient_no_shows')
      .limit(200),
    supabase.rpc('appointments_for_day', { p_day: today }),
  ]);
  const rows = (queue ?? []).filter((r) => !mine || !r.assignee_id || r.assignee_id === member.userId);
  const ranked = rankQueue(rows as QueueRow[]).slice(0, 60);

  return (
    <>
      <div className="card">
        <h2>Needs attention</h2>
        <p className="muted">
          {mine ? <Link href="/today">Show everything</Link> : <Link href="/today?mine=1">Show only mine</Link>}
          {' · '}Most important first. Each item says why.
        </p>
        {error && <p className="error">Could not load the queue.</p>}
        {!error && ranked.length === 0 && <p className="muted">Nothing overdue.</p>}
        <ul className="list">
          {ranked.map((row) => {
            const href = linkFor(row);
            return (
              <li key={`${row.kind}-${row.ref_id}`}>
                <strong className={row.severity === 'urgent' ? 'error' : undefined}>{LABEL[row.kind] ?? row.kind}</strong>{' '}
                {href ? <Link href={href}>{row.title}</Link> : row.title}
                <div className="muted">{row.reason}</div>
              </li>
            );
          })}
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
