import Link from 'next/link';
import { requireMember } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { dateIn } from '@/lib/dates';
import { RECALL_REASONS } from '@/lib/constants';
import { closeRecall } from './actions';

export const dynamic = 'force-dynamic';

const one = <T,>(v: T | T[] | null): T | null => (Array.isArray(v) ? v[0] ?? null : v);

// Roadmap #21. No-shows open a recall automatically; patients in treatment with no visit for the
// clinic's lapsed period are added by the worker. Up to three WhatsApp messages (or call tasks),
// then a final call. A new booking closes the recall as recovered; otherwise staff log a reason.
export default async function RecallsPage({ searchParams }: { searchParams: { error?: string; ok?: string } }) {
  const member = await requireMember();
  const supabase = createClient();
  const [{ data: open, error }, { data: closed }] = await Promise.all([
    supabase.from('recalls')
      .select('id, patient_id, kind, attempts, next_attempt_at, created_at, patients(full_name, phone, whatsapp_opt_in)')
      .eq('status', 'open').order('created_at').limit(200),
    supabase.from('recalls').select('status, reason')
      .neq('status', 'open').gte('closed_at', new Date(Date.now() - 90 * 86400_000).toISOString()),
  ]);
  const tz = member.timezone;
  const recovered = closed?.filter((r) => r.status === 'booked').length ?? 0;
  const reasons = Object.entries(
    (closed ?? []).filter((r) => r.status === 'closed').reduce<Record<string, number>>((acc, r) => {
      const k = (r.reason ?? 'Unknown').split(':')[0];
      acc[k] = (acc[k] ?? 0) + 1;
      return acc;
    }, {}),
  ).sort((a, b) => b[1] - a[1]);

  return (
    <>
      {searchParams.error && <p className="error">{searchParams.error}</p>}
      {searchParams.ok && <p>{searchParams.ok}</p>}

      <div className="card">
        <h2>Open recalls</h2>
        {error && <p className="error">Could not load recalls.</p>}
        {(open?.length ?? 0) === 0 && <p className="muted">Nobody to recall.</p>}
        <ul className="list">
          {open?.map((r) => {
            const p = one(r.patients);
            return (
              <li key={r.id}>
                <Link href={`/patients/${r.patient_id}`}>{p?.full_name ?? 'Patient'}</Link>{' '}
                <span className="muted">
                  {r.kind === 'no_show' ? 'missed appointment' : 'lapsed'} · {p?.phone} ·
                  {' '}{r.attempts}/3 attempts{r.attempts < 3 ? ` · next ${dateIn(r.next_attempt_at, tz)}` : ''}
                  {p?.whatsapp_opt_in ? '' : ' · no WhatsApp: call'}
                </span>
                <div><Link href={`/appointments?patient=${r.patient_id}`}>Book them in</Link> (closes the recall automatically)</div>
                <form action={closeRecall}>
                  <input type="hidden" name="id" value={r.id} />
                  <select name="reason" defaultValue="" aria-label="Reason" required>
                    <option value="" disabled>Why are they not coming back?</option>
                    {RECALL_REASONS.map((x) => <option key={x} value={x}>{x}</option>)}
                  </select>
                  <button type="submit" className="link">Close recall</button>
                </form>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="card">
        <h2>Last 90 days</h2>
        <p><strong>{recovered}</strong> recovered (rebooked) · <strong>{(closed?.length ?? 0) - recovered}</strong> closed without a booking</p>
        {reasons.length > 0 && (
          <ul className="list">
            {reasons.map(([k, n]) => <li key={k}>{k}: <strong>{n}</strong></li>)}
          </ul>
        )}
      </div>
    </>
  );
}
