import Link from 'next/link';
import { requirePermission } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { dateIn, timeIn } from '@/lib/dates';
import { acknowledgeConcern, recordCheckin, resolveConcern } from './actions';

export const dynamic = 'force-dynamic';

const one = <T,>(v: T | T[] | null): T | null => (Array.isArray(v) ? v[0] ?? null : v);
const SEVERITY_ORDER: Record<string, number> = { urgent: 0, unclear: 1, mild: 2 };

// Roadmap #20: every concern has a clinician, an alert on the Today queue, and a logged outcome.
// The clinician's own label on resolution measures how well reply sorting agrees with them (#19).
export default async function ConcernsPage({ searchParams }: { searchParams: { error?: string; ok?: string; all?: string } }) {
  const member = await requirePermission('concern:view');
  const supabase = createClient();
  const showAll = searchParams.all === '1';

  let q = supabase.from('patient_concerns')
    .select('id, patient_id, severity, topic, summary, source, status, assigned_to, created_at, acknowledged_at, outcome, patients(full_name)')
    .order('created_at', { ascending: false }).limit(100);
  if (!showAll) q = q.neq('status', 'resolved');
  const [{ data: concerns, error }, { data: staff }, { data: checkins }] = await Promise.all([
    q,
    supabase.from('clinic_members').select('user_id, display_name'),
    supabase.from('checkins').select('id, patient_id, status, created_at, patients(full_name)')
      .eq('status', 'pending').order('created_at').limit(50),
  ]);
  const name = (uid: string | null) => staff?.find((s) => s.user_id === uid)?.display_name ?? 'Unassigned';
  const sorted = [...(concerns ?? [])].sort((a, b) =>
    (a.status === 'resolved' ? 1 : 0) - (b.status === 'resolved' ? 1 : 0)
    || (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9));
  const tz = member.timezone;

  return (
    <>
      {searchParams.error && <p className="error">{searchParams.error}</p>}
      {searchParams.ok && <p>{searchParams.ok}</p>}

      <div className="card">
        <h2>Patient concerns</h2>
        <p className="muted">
          {showAll ? <Link href="/concerns">Open only</Link> : <Link href="/concerns?all=1">Include resolved</Link>}
          {' · '}Urgent first. Urgent and unclear replies are never handled automatically.
        </p>
        {error && <p className="error">Could not load concerns.</p>}
        {sorted.length === 0 && <p className="muted">No open concerns.</p>}
        <ul className="list">
          {sorted.map((c) => (
            <li key={c.id}>
              <strong className={c.severity === 'urgent' ? 'error' : undefined}>{c.severity}</strong>{' '}
              <Link href={`/patients/${c.patient_id}`}>{one(c.patients)?.full_name ?? 'Patient'}</Link>
              {c.topic && <span className="muted"> · {c.topic.replace(/_/g, ' ')}</span>}
              <div>{c.summary}</div>
              <div className="muted">
                {c.source} · {dateIn(c.created_at, tz)} {timeIn(c.created_at, tz)} · {name(c.assigned_to)} · {c.status}
              </div>
              {c.status === 'open' && (
                <form action={acknowledgeConcern} style={{ display: 'inline' }}>
                  <input type="hidden" name="id" value={c.id} />
                  <button type="submit" className="link">Acknowledge</button>
                </form>
              )}
              {c.status !== 'resolved' ? (
                <form action={resolveConcern}>
                  <input type="hidden" name="id" value={c.id} />
                  <input name="outcome" placeholder="What was done" aria-label="Outcome" required />
                  <select name="clinician_label" defaultValue="" aria-label="Your assessment">
                    <option value="">Your assessment (optional)</option>
                    <option value="urgent">Was urgent</option>
                    <option value="mild">Was mild</option>
                    <option value="fine">Was fine</option>
                  </select>
                  <button type="submit">Resolve</button>
                </form>
              ) : (
                <div className="muted">Outcome: {c.outcome}</div>
              )}
            </li>
          ))}
        </ul>
      </div>

      <div className="card">
        <h2>Check-ins to do by phone</h2>
        <p className="muted">These patients have no WhatsApp opt-in or no approved template in their language.</p>
        {(checkins?.length ?? 0) === 0 && <p className="muted">None.</p>}
        <ul className="list">
          {checkins?.map((k) => (
            <li key={k.id}>
              <Link href={`/patients/${k.patient_id}`}>{one(k.patients)?.full_name ?? 'Patient'}</Link>{' '}
              <span className="muted">since {dateIn(k.created_at, tz)}</span>
              <form action={recordCheckin}>
                <input type="hidden" name="id" value={k.id} />
                <input name="note" placeholder="What did they say?" aria-label="Note" />
                <button name="status" value="ok" type="submit">All fine</button>{' '}
                <button name="status" value="concern" type="submit" className="link">Raise a concern</button>{' '}
                <button name="status" value="cancelled" type="submit" className="link">Could not reach</button>
              </form>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}
