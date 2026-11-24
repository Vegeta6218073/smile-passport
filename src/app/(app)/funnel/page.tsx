import Link from 'next/link';
import { requirePermission } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { shiftDay, todayIn } from '@/lib/dates';

export const dynamic = 'force-dynamic';

const RANGES = [7, 30, 90] as const;

const pct = (n: number, d: number) => (d > 0 ? `${Math.round((n / d) * 100)}%` : '–');

// The four numbers from the Smile Passport plan, plus treatments started.
// Cohort view: of the people who scanned in this period, how far did they get.
export default async function FunnelPage({ searchParams }: { searchParams: { days?: string } }) {
  const member = await requirePermission('funnel:view');
  const days = RANGES.find((r) => String(r) === searchParams.days) ?? 30;
  const to = todayIn(member.timezone);
  const from = shiftDay(to, -(days - 1));

  const { data, error } = await createClient().rpc('smile_funnel', { p_from: from, p_to: to });
  const row = data?.[0] ?? { visits: 0, scans: 0, reviews_delivered: 0, consults_booked: 0, treatments_started: 0 };
  const n = (v: unknown) => Number(v ?? 0);

  const steps = [
    ['Visitors', n(row.visits), null],
    ['Scans completed', n(row.scans), pct(n(row.scans), n(row.visits))],
    ['Professional reviews delivered', n(row.reviews_delivered), pct(n(row.reviews_delivered), n(row.scans))],
    ['Consultations booked', n(row.consults_booked), pct(n(row.consults_booked), n(row.reviews_delivered))],
    ['Treatments started', n(row.treatments_started), pct(n(row.treatments_started), n(row.consults_booked))],
  ] as const;

  return (
    <div className="card">
      <h2>Smile Passport funnel</h2>
      <p>
        {RANGES.map((r) => (
          <span key={r}>
            {r === days ? <strong>Last {r} days</strong> : <Link href={`/funnel?days=${r}`}>Last {r} days</Link>}{' · '}
          </span>
        ))}
      </p>
      {error && <p className="error">Could not load the funnel.</p>}
      <ul className="list">
        {steps.map(([label, value, rate]) => (
          <li key={label}>
            <strong>{value}</strong> {label}{rate ? <span className="muted"> · {rate} of the step before</span> : null}
          </li>
        ))}
      </ul>
      <p className="muted">
        Visitors counts page loads of the landing page and skips obvious crawlers, so treat it as
        approximate. The other numbers count people who scanned in this period.
      </p>
    </div>
  );
}
